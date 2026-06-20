import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceConfigWithTestAi } from "./support/ai-config.mjs";

/**
 * @typedef {{ body?: Record<string, any>; method: string; url: string }} FetchRequest
 * @typedef {{ mock: { calls: Array<[string | URL, { body?: string; method?: string }?]> } }} MockFetch
 */

const { runStage } = await import("../src/runner/stage-runner.ts");

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = {
    ...originalEnv,
    GITVIBE_AI_ENV_JSON: JSON.stringify({
      GITVIBE_AI_API_KEY: "test-key",
    }),
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  vi.unstubAllEnvs();
});

describe("stage runner issue dry-runs", () => {
  it("runs read-only stages in dry-run mode without AI or writes", async () => {
    const cwd = await workspace();
    const fetch = fetchMock([
      issueResponse("Issue body"),
      commentsResponse([{ body: "Comment", created_at: "2026-01-03T00:00:00Z", id: 3 }]),
    ]);
    globalThis.fetch = fetch;

    const result = await runStage({
      cwd,
      dryRun: true,
      issueNumber: "12",
      maxTurns: 2,
      prNumber: "",
      repository: "example/repo",
      stage: "investigate",
      stageTimeoutMinutes: 1,
      token: "token",
    });

    expect(result).toMatchObject({
      schemaId: "investigate.v1",
      status: "completed",
      summary: "Dry run completed for investigate.",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("stage runner discussion dry-runs", () => {
  it("renders dry-run outputs for materialize", async () => {
    const cwd = await workspace();
    process.env.GITVIBE_DISCUSSION_NUMBER = "5";
    globalThis.fetch = fetchMock([discussionResponse()]);

    await expect(
      runStage({
        cwd,
        dryRun: true,
        issueNumber: "",
        maxTurns: 2,
        prNumber: "",
        repository: "example/repo",
        stage: "materialize",
        stageTimeoutMinutes: 1,
        token: "token",
      }),
    ).resolves.toMatchObject({
      parsedOutput: { issues: [{ title: "GitVibe dry run: Discussion title" }] },
    });
  });
});

describe("stage runner discussion context selection", () => {
  it("uses discussion context for validate when only a discussion number is present", async () => {
    const cwd = await workspace();
    process.env.GITVIBE_DISCUSSION_NUMBER = "5";
    globalThis.fetch = fetchMock([discussionResponse()]);

    await expect(
      runStage({
        cwd,
        dryRun: true,
        issueNumber: "",
        maxTurns: 2,
        prNumber: "",
        repository: "example/repo",
        stage: "validate",
        stageTimeoutMinutes: 1,
        token: "token",
      }),
    ).resolves.toMatchObject({
      parsedOutput: { comment_body: "GitVibe dry run for validate on discussion #5." },
    });
  });

  it("uses the issue-number fallback for discussion-target stages", async () => {
    const cwd = await workspace();
    delete process.env.GITVIBE_DISCUSSION_NUMBER;
    globalThis.fetch = fetchMock([discussionResponse()]);

    await expect(
      runStage({
        cwd,
        dryRun: true,
        issueNumber: "5",
        maxTurns: 2,
        prNumber: "",
        repository: "example/repo",
        stage: "materialize",
        stageTimeoutMinutes: 1,
        token: "token",
      }),
    ).resolves.toMatchObject({
      parsedOutput: { comment_body: "GitVibe dry run for materialize on discussion #5." },
    });
  });
});

describe("stage runner materialize writes", () => {
  it("materializes implementation issues and comments back to the source discussion", async () => {
    const cwd = await workspace();
    process.env.GITVIBE_DISCUSSION_NUMBER = "5";
    globalThis.__gitVibeSdkMocks.queueCodexOutput(materializeOutput());
    const fetch = fetchMock([
      discussionResponse(),
      response(200, { html_url: "https://github.com/example/repo/issues/13", number: 13 }),
      graphqlResponse({ addDiscussionComment: { comment: { id: "comment", url: "url" } } }),
      graphqlResponse({ closeDiscussion: { discussion: { id: "discussion-id" } } }),
    ]);
    globalThis.fetch = fetch;

    const result = await runStage({
      cwd,
      dryRun: false,
      issueNumber: "",
      maxTurns: 2,
      prNumber: "",
      repository: "example/repo",
      sourceComment: {
        kind: "discussion-comment",
        nodeId: "discussion-command-reply",
      },
      stage: "materialize",
      stageTimeoutMinutes: 1,
      token: "token",
    });

    expect(result.summary).toBe("Materialized.");
    expect(fetch.mock.calls[1][0]).toContain("/repos/example/repo/issues");
    expect(JSON.parse(fetch.mock.calls[1][1].body).labels).toEqual(["gvi:story"]);
    expect(JSON.parse(fetch.mock.calls[2][1].body).variables.body).toContain(
      "GitVibe created implementation issue #13",
    );
    expect(JSON.parse(fetch.mock.calls[2][1].body).variables.replyToId).toBe(
      "discussion-parent-comment",
    );
    expect(JSON.parse(fetch.mock.calls[3][1].body).query).toContain("GitVibeCloseDiscussion");
    expect(JSON.parse(fetch.mock.calls[3][1].body).variables.discussionId).toBe("discussion-id");
  });
});

describe("stage runner materialize fallbacks", () => {
  it("materializes with fallback issue fields and skips discussion comments without a target", async () => {
    const cwd = await workspace();
    process.env.GITVIBE_DISCUSSION_NUMBER = "5";
    globalThis.__gitVibeSdkMocks.queueCodexOutput(materializeOutput({ backpressure_commands: [] }));
    const fetch = fetchMock([discussionWithoutIdResponse(), response(200, { number: 13 })]);
    globalThis.fetch = fetch;

    await expect(
      runStage({
        cwd,
        dryRun: false,
        issueNumber: "",
        maxTurns: 2,
        prNumber: "",
        repository: "example/repo",
        stage: "materialize",
        stageTimeoutMinutes: 1,
        token: "token",
      }),
    ).resolves.toMatchObject({ status: "completed" });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1][1].body).title).toBe("Implement feature");
  });
});

describe("stage runner review-matrix start labels", () => {
  it("marks pull requests as reviewing at stage start without requiring a workflow run URL", async () => {
    const cwd = await workspace();
    globalThis.__gitVibeSdkMocks.queueCodexOutput(reviewMatrixOutput());
    const fetch = fetchMock([
      issueResponse("PR body"),
      commentsResponse([]),
      pullRequestResponse("feature/review"),
      reviewThreadsResponse(),
      pullRequestReviewsResponse([]),
      pullRequestFilesResponse([]),
      response(200, {}),
    ]);
    globalThis.fetch = fetch;

    const result = await runStage({
      cwd,
      dryRun: false,
      issueNumber: "",
      maxTurns: 2,
      prNumber: "12",
      repository: "example/repo",
      stage: "review-matrix",
      stageTimeoutMinutes: 1,
      token: "token",
    });

    expect(result).toMatchObject({
      parsedOutput: { next_state: "review-passed" },
      status: "completed",
    });
    const requests = fetchRequests(fetch);
    const reviewingLabelIndex = requests.findIndex(
      (request) =>
        request.method === "POST" &&
        request.url.endsWith("/repos/example/repo/issues/12/labels") &&
        request.body?.labels?.includes("gvi:reviewing"),
    );
    const reviewPostIndex = requests.findIndex(
      (request) =>
        request.method === "POST" && request.url.endsWith("/repos/example/repo/pulls/12/reviews"),
    );
    expect(reviewingLabelIndex).toBeGreaterThan(-1);
    expect(reviewPostIndex).toBeGreaterThan(-1);
    expect(reviewingLabelIndex).toBeLessThan(reviewPostIndex);
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "DELETE",
          url: expect.stringContaining(
            "/repos/example/repo/issues/12/labels/gvi%3Aready-for-approval",
          ),
        }),
        expect.objectContaining({
          body: { labels: ["gvi:reviewing"] },
          method: "POST",
          url: expect.stringContaining("/repos/example/repo/issues/12/labels"),
        }),
      ]),
    );
  });
});

/**
 * @param {string} [config]
 * @returns {Promise<string>}
 */
async function workspace(config = "") {
  const cwd = await mkdtemp(join(tmpdir(), "git-vibe-stage-"));
  process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), "git-vibe-runner-"));
  mkdirSync(join(cwd, ".github"));
  writeFileSync(join(cwd, ".github", "git-vibe.yml"), workspaceConfigWithTestAi(config));
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  return cwd;
}

/**
 * @param {any[]} responses
 */
function fetchMock(responses) {
  return vi.fn(
    /**
     * @param {any} url
     * @param {any} [init]
     */
    async (url, init = {}) => {
      if (isLabelRequest(url, init)) return response(200, {});
      const next = responses.shift();
      if (!next) throw new Error("unexpected fetch");
      return next;
    },
  );
}

/**
 * @param {any} url
 * @param {any} init
 */
function isLabelRequest(url, init) {
  const method = String(init.method || "GET").toUpperCase();
  return method === "POST"
    ? /\/issues\/\d+\/labels$/.test(String(url))
    : method === "DELETE" && String(url).includes("/labels/");
}

/**
 * @param {string} body
 * @param {Record<string, unknown>} [overrides]
 */
function issueResponse(body, overrides = {}) {
  return response(200, {
    body,
    created_at: "2026-01-02T00:00:00Z",
    html_url: "https://github.com/example/repo/issues/12",
    number: 12,
    title: "Issue title",
    user: { login: "octocat" },
    ...overrides,
  });
}

/** @param {unknown[]} comments */
const commentsResponse = (comments) => response(200, comments);
function discussionResponse() {
  return graphqlResponse({
    repository: {
      discussion: {
        author: { login: "octocat" },
        body: "Discussion body",
        comments: {
          nodes: [
            {
              id: "discussion-parent-comment",
              replies: { nodes: [{ id: "discussion-command-reply" }] },
            },
          ],
        },
        createdAt: "2026-01-02T00:00:00Z",
        id: "discussion-id",
        title: "Discussion title",
        url: "https://github.com/example/repo/discussions/5",
      },
    },
  });
}

function discussionWithoutIdResponse() {
  return graphqlResponse({
    repository: {
      discussion: {
        author: { login: "octocat" },
        body: "Discussion body",
        comments: { nodes: [] },
        createdAt: "2026-01-02T00:00:00Z",
        title: "Discussion title",
        url: "https://github.com/example/repo/discussions/5",
      },
    },
  });
}

/**
 * @param {string} branch
 * @param {string} [sha]
 */
function pullRequestResponse(branch, sha = "current-sha") {
  return response(200, { head: { ref: branch, repo: { full_name: "example/repo" }, sha } });
}

function reviewThreadsResponse() {
  return graphqlResponse({ repository: { pullRequest: { reviewThreads: { nodes: [] } } } });
}

/** @param {unknown[]} reviews */
const pullRequestReviewsResponse = (reviews) => response(200, reviews);
/** @param {unknown[]} files */
const pullRequestFilesResponse = (files) => response(200, files);

function materializeOutput(issueOverrides = {}) {
  return {
    assumptions: [],
    comment_body: "Created issue.",
    findings: [],
    issues: [
      {
        acceptance_criteria: ["Issue is created."],
        background: "Implementation body.",
        backpressure_commands: ["corepack pnpm test"],
        blocked_by: [],
        parallel_group: "default",
        requirements: ["Implement feature."],
        review_guidelines: ["Verify behavior."],
        title: "Implement feature",
        ...issueOverrides,
      },
    ],
    next_state: "implementation-issues-ready",
    references: [],
    stage: "materialize",
    status: "completed",
    summary: "Materialized.",
  };
}

function reviewMatrixOutput() {
  return {
    assumptions: [],
    comment_body: "Reviewed.",
    findings: [],
    next_state: "review-passed",
    references: [],
    stage: "review-matrix",
    status: "completed",
    summary: "Reviewed.",
  };
}

/**
 * @param {MockFetch} fetch
 * @returns {FetchRequest[]}
 */
function fetchRequests(fetch) {
  return fetch.mock.calls.map(([url, init = {}]) => ({
    body: init.body ? JSON.parse(init.body) : undefined,
    method: String(init.method || "GET").toUpperCase(),
    url: String(url),
  }));
}

/** @param {Record<string, unknown>} data */
const graphqlResponse = (data) => response(200, { data });

/**
 * @param {number} status
 * @param {unknown} value
 * @returns {any}
 */
const response = (status, value) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(value),
});
