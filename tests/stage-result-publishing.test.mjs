import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceConfigWithTestAi } from "./support/ai-config.mjs";
import { parseDecomposeJson } from "../src/runner/result-comments.ts";

const generateText = vi.fn();
const createOpenAI = vi.fn(() => ({ chat: vi.fn(() => "openai-model") }));
const createAnthropic = vi.fn(() => ({ languageModel: vi.fn(() => "anthropic-model") }));

vi.mock("ai", () => ({
  generateText,
  hasToolCall: vi.fn((toolName) => ({ toolName })),
  stepCountIs: vi.fn((count) => ({ count })),
}));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic }));

const { runStage } = await import("../src/runner/stage-runner.ts");

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  generateText.mockReset();
  process.env = {
    ...originalEnv,
    GITVIBE_AI_ENV_JSON: JSON.stringify({
      GITVIBE_AI_API_KEY: "test-key",
      GITVIBE_AI_BASE_URL: "https://proxy.test/v1",
    }),
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

describe("stage result publishing", () => {
  it("publishes validate results to issues and marks ready issues for approval", async () => {
    const cwd = await workspace();
    generateText.mockResolvedValueOnce(aiResult(validateOutput()));
    const fetch = fetchMock([
      issueResponse("Issue body"),
      commentsResponse([]),
      response(200, {}),
      response(200, {}),
      response(200, {}),
    ]);
    globalThis.fetch = fetch;

    const result = await runStage({
      cwd,
      dryRun: false,
      issueNumber: "12",
      maxTurns: 2,
      prNumber: "",
      repository: "example/repo",
      stage: "validate",
      stageTimeoutMinutes: 1,
      token: "token",
      workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
    });

    const startBody = JSON.parse(fetch.mock.calls[2][1].body).body;
    const commentBody = JSON.parse(fetch.mock.calls[3][1].body).body;
    expect(result.commentBody).toContain("## GitVibe Validation");
    expect(startBody).toContain("<!-- git-vibe:stage-start");
    expect(startBody).toContain("stage=validate");
    expect(startBody).toContain("run=99");
    expect(startBody).toContain("Workflow run: https://github.com/example/repo/actions/runs/99");
    expect(commentBody).toContain("<!-- git-vibe:stage-result stage=validate");
    expect(commentBody).toContain("Workflow run: https://github.com/example/repo/actions/runs/99");
    expect(JSON.parse(fetch.mock.calls[4][1].body).labels).toEqual(["gvi:ready-for-approval"]);
  });
});

describe("decompose result publishing", () => {
  it("publishes decompose results, deletes prior decompose results, and marks decomposed", async () => {
    const cwd = await workspace();
    process.env.GITVIBE_DISCUSSION_NUMBER = "5";
    generateText.mockResolvedValueOnce(aiResult(decomposeOutput()));
    const fetch = fetchMock([
      discussionResponse({
        comments: [priorDecomposeComment()],
        labels: ["gvi:validated"],
      }),
    ]);
    globalThis.fetch = fetch;

    await runStage({
      cwd,
      dryRun: false,
      issueNumber: "",
      maxTurns: 2,
      prNumber: "",
      repository: "example/repo",
      stage: "decompose",
      stageTimeoutMinutes: 1,
      token: "token",
    });

    const deletedIds = graphqlVariables(fetch, "GitVibeDeleteDiscussionComment").map(
      (variables) => variables.id,
    );
    const commentBody = graphqlVariables(fetch, "GitVibeAddDiscussionComment").at(-1).body;
    const resolvedLabels = graphqlVariables(fetch, "GitVibeDiscussionLabelId").map(
      (variables) => variables.label,
    );
    expect(deletedIds).toEqual(["old-decompose-comment"]);
    expect(commentBody).toContain("<!-- git-vibe:decompose-result");
    expect(parseDecomposeJson(commentBody)).toMatchObject({ stage: "decompose" });
    expect(resolvedLabels).toContain("gvi:decomposing");
    expect(resolvedLabels).toContain("gvi:decomposed");
  });

  it("blocks decompose when the discussion is not validated", async () => {
    const cwd = await workspace();
    process.env.GITVIBE_DISCUSSION_NUMBER = "5";
    const fetch = fetchMock([discussionResponse({ labels: [] })]);
    globalThis.fetch = fetch;

    const result = await runStage({
      cwd,
      dryRun: false,
      issueNumber: "",
      maxTurns: 2,
      prNumber: "",
      repository: "example/repo",
      stage: "decompose",
      stageTimeoutMinutes: 1,
      token: "token",
    });

    const commentBody = graphqlVariables(fetch, "GitVibeAddDiscussionComment").at(-1).body;
    expect(result.status).toBe("blocked");
    expect(generateText).not.toHaveBeenCalled();
    expect(commentBody).toContain("has not completed validation");
    expect(commentBody).not.toContain("git-vibe:decompose-result");
  });
});

describe("stage result PR replies", () => {
  it("posts PR feedback completion results to the pull request conversation", async () => {
    const cwd = await workspace();
    commitAll(cwd);
    generateText.mockResolvedValueOnce(aiResult(feedbackOutput()));
    const fetch = fetchMock([
      issueResponse("PR body"),
      commentsResponse([]),
      pullRequestResponse("git-vibe/12"),
      reviewThreadsResponse(),
      response(200, {}),
    ]);
    globalThis.fetch = fetch;

    await runStage({
      cwd,
      dryRun: false,
      issueNumber: "",
      maxTurns: 2,
      prNumber: "12",
      repository: "example/repo",
      sourceComment: {
        kind: "pull-request-comment",
        url: "https://github.com/example/repo/pull/12#issuecomment-2",
      },
      stage: "address-pr-feedback",
      stageTimeoutMinutes: 1,
      token: "token",
    });

    const commentCall = issueCommentCall(fetch);
    expect(commentCall[0]).toContain("/repos/example/repo/issues/12/comments");
    expect(JSON.parse(commentCall[1].body).body).toContain("## GitVibe PR Feedback Update");
    expect(JSON.parse(commentCall[1].body).body).toContain(
      "In reply to: https://github.com/example/repo/pull/12#issuecomment-2",
    );
  });

  it("posts PR feedback completion results as review comment replies", async () => {
    const cwd = await workspace();
    commitAll(cwd);
    generateText.mockResolvedValueOnce(aiResult(feedbackOutput()));
    const fetch = fetchMock([
      issueResponse("PR body"),
      commentsResponse([]),
      pullRequestResponse("git-vibe/12"),
      reviewThreadsResponse(),
      response(200, {}),
    ]);
    globalThis.fetch = fetch;

    await runStage({
      cwd,
      dryRun: false,
      issueNumber: "",
      maxTurns: 2,
      prNumber: "12",
      repository: "example/repo",
      sourceComment: {
        id: "88",
        kind: "pull-request-review-comment",
        url: "https://github.com/example/repo/pull/12#discussion_r88",
      },
      stage: "address-pr-feedback",
      stageTimeoutMinutes: 1,
      token: "token",
    });

    const replyCall = fetch.mock.calls.find(([url]) =>
      String(url).includes("/repos/example/repo/pulls/12/comments/88/replies"),
    );
    expect(replyCall).toBeDefined();
    expect(JSON.parse(String(replyCall?.[1]?.body)).body).toContain(
      "## GitVibe PR Feedback Update",
    );
  });
});

/**
 * @param {string} [config]
 * @returns {Promise<string>}
 */
async function workspace(config = "") {
  const cwd = await mkdtemp(join(tmpdir(), "git-vibe-publish-"));
  process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), "git-vibe-runner-"));
  mkdirSync(join(cwd, ".github"));
  writeFileSync(join(cwd, ".github", "git-vibe.yml"), workspaceConfigWithTestAi(config));
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  return cwd;
}

/**
 * @param {string} cwd
 */
function commitAll(cwd) {
  execFileSync("git", ["config", "user.name", "tester"], { cwd });
  execFileSync("git", ["config", "user.email", "tester@example.com"], { cwd });
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "-m", "initial"], { cwd, stdio: "ignore" });
}

/**
 * @param {Record<string, unknown>} output
 */
function aiResult(output) {
  return {
    steps: [
      { toolCalls: [{ input: { content: JSON.stringify(output) }, toolName: "output_validator" }] },
    ],
    text: "{}",
  };
}

function validateOutput() {
  return {
    assumptions: [],
    comment_body: "Ready for approval.",
    findings: ["Implementation scope is clear."],
    next_state: "ready-for-implementation",
    questions: [],
    references: [],
    stage: "validate",
    status: "completed",
    summary: "Validation complete.",
  };
}

function feedbackOutput() {
  return {
    assumptions: [],
    comment_body: "Feedback addressed.",
    findings: ["No code changes were needed."],
    next_state: "feedback-addressed",
    references: [],
    skipped_feedback: [],
    stage: "address-pr-feedback",
    status: "completed",
    summary: "PR feedback handled.",
    tests: [],
  };
}

function decomposeOutput() {
  return {
    assumptions: [],
    comment_body: "Decomposition details.",
    findings: ["The discussion is validated."],
    next_state: "ready-for-materialization",
    references: ["https://github.com/example/repo/discussions/5"],
    stage: "decompose",
    status: "completed",
    story_units: [
      {
        acceptance_criteria: ["The decompose result is posted."],
        background: "Maintainers need a plan.",
        backpressure_commands: [],
        blocked_by: [],
        parallel_group: "foundation",
        requirements: ["Add the decompose stage."],
        review_guidelines: ["Verify marker parsing."],
        title: "Add decompose stage",
      },
    ],
    summary: "Decomposition ready.",
  };
}

function priorDecomposeComment() {
  return {
    author: { login: "git-vibe" },
    body: "<!-- git-vibe:decompose-result artifact=discussion number=5 schema=decompose.v1 -->\nold",
    createdAt: "2026-01-03T00:00:00Z",
    id: "old-decompose-comment",
    replies: { nodes: [] },
    url: "https://github.com/example/repo/discussions/5#discussioncomment-old",
  };
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
      const genericGraphql = genericGraphqlResponse(url, init);
      if (genericGraphql) return genericGraphql;
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
function genericGraphqlResponse(url, init) {
  if (!String(url).endsWith("/graphql")) return undefined;
  const query = String(JSON.parse(String(init.body || "{}")).query || "");
  if (query.includes("GitVibeDiscussionLabelId")) {
    return graphqlResponse({ repository: { label: { id: "label-node" } } });
  }
  if (query.includes("GitVibeAddDiscussionLabel")) {
    return graphqlResponse({ addLabelsToLabelable: { clientMutationId: null } });
  }
  if (query.includes("GitVibeRemoveDiscussionLabel")) {
    return graphqlResponse({ removeLabelsFromLabelable: { clientMutationId: null } });
  }
  if (query.includes("GitVibeDeleteDiscussionComment")) {
    return graphqlResponse({ deleteDiscussionComment: { clientMutationId: null } });
  }
  if (query.includes("GitVibeAddDiscussionComment")) {
    return graphqlResponse({ addDiscussionComment: { comment: { id: "comment", url: "url" } } });
  }
  return undefined;
}

/**
 * @param {any} fetch
 */
function issueCommentCall(fetch) {
  return fetch.mock.calls.find(
    /**
     * @param {any[]} call
     */
    (call) => {
      const [url, init] = call;
      return (
        String(url).includes("/repos/example/repo/issues/12/comments") &&
        String(init?.method || "GET").toUpperCase() === "POST"
      );
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
 */
function issueResponse(body) {
  return response(200, {
    body,
    created_at: "2026-01-02T00:00:00Z",
    html_url: "https://github.com/example/repo/issues/12",
    number: 12,
    title: "Issue title",
    user: { login: "octocat" },
  });
}

/**
 * @param {unknown[]} comments
 */
function commentsResponse(comments) {
  return response(200, comments);
}

function reviewThreadsResponse() {
  return graphqlResponse({
    repository: {
      pullRequest: {
        reviewThreads: { nodes: [] },
      },
    },
  });
}

/**
 * @param {string} branch
 */
function pullRequestResponse(branch) {
  return response(200, { head: { ref: branch, repo: { full_name: "example/repo" } } });
}

/**
 * @param {{ comments?: any[], labels?: string[] }} [options]
 */
function discussionResponse(options = {}) {
  return graphqlResponse({
    repository: {
      discussion: {
        author: { login: "octocat" },
        body: "Discussion body",
        comments: { nodes: options.comments || [] },
        createdAt: "2026-01-02T00:00:00Z",
        id: "discussion-id",
        labels: { nodes: (options.labels || []).map((name) => ({ name })) },
        title: "Discussion title",
        url: "https://github.com/example/repo/discussions/5",
      },
    },
  });
}

/**
 * @param {Record<string, unknown>} data
 */
function graphqlResponse(data) {
  return response(200, { data });
}

/**
 * @param {any} fetch
 * @param {string} operation
 * @returns {any[]}
 */
function graphqlVariables(fetch, operation) {
  const variables = [];
  for (const call of fetch.mock.calls) {
    const [url, init] = call;
    if (!String(url).endsWith("/graphql")) continue;
    if (!String(JSON.parse(String(init?.body || "{}")).query || "").includes(operation)) continue;
    variables.push(JSON.parse(String(init.body)).variables);
  }
  return variables;
}

/**
 * @param {number} status
 * @param {unknown} value
 * @returns {any}
 */
function response(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(value),
  };
}
