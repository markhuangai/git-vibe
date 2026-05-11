// @ts-nocheck
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendIssueTraceability,
  handleReviewFixRequired,
  prepareIssueBranch,
} from "../src/runner/review-fix.ts";
import { reviewFixIssueMarker, reviewFixLinkComment } from "../src/shared/traceability.ts";
import { workspaceConfigWithTestAi } from "./support/ai-config.mjs";

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
  delete process.env.GITVIBE_BASE_BRANCH;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  vi.unstubAllEnvs();
});

describe("stage runner review-fix writes", () => {
  it("creates a review-fix issue, links it as a sub-issue, and dispatches development", async () => {
    const cwd = await workspace();
    process.env.GITVIBE_BASE_BRANCH = "develop";
    mockReviewChanges();
    const fetch = fetchMock([
      issueResponse("Issue body"),
      commentsResponse([]),
      response(200, { html_url: "https://github.com/example/repo/issues/13", id: 99, number: 13 }),
      response(200, {}),
      response(200, {}),
      response(204, {}),
      response(200, {}),
    ]);
    globalThis.fetch = fetch;

    await expect(runStageFor("review-matrix", cwd, "12")).resolves.toMatchObject({
      status: "completed",
    });

    const issue = bodyAt(fetch, 2);
    expect(issue.labels).toEqual(["gvi:review-fix"]);
    expect(issue.body).toContain(
      "git-vibe:review-fix kind=issue root=12 parent=12 branch=git-vibe/12 depth=1",
    );
    expect(issue.body).toContain("src/foo.ts: fix required");
    expect(bodyAt(fetch, 3).body).toContain("Follow-up review-fix issue: #13");
    expect(fetch.mock.calls[4][0]).toContain("/repos/example/repo/issues/12/sub_issues");
    expect(fetch.mock.calls[4][1].headers["x-github-api-version"]).toBe("2026-03-10");
    expect(bodyAt(fetch, 4)).toEqual({ sub_issue_id: 99 });
    expect(fetch.mock.calls[5][0]).toContain(
      "/repos/example/repo/actions/workflows/develop.yml/dispatches",
    );
    expect(bodyAt(fetch, 5)).toEqual({
      inputs: { "issue-number": "13" },
      ref: "develop",
      return_run_details: true,
    });
    expect(bodyAt(fetch, 6).body).toContain("GitVibe Workflow Queued");
  });

  it("reuses an existing review-fix link on retry", async () => {
    const cwd = await workspace();
    mockReviewChanges({ references: [], tests: [] });
    const fetch = fetchMock([
      issueResponse("Issue body"),
      commentsResponse([existingReviewFixLink()]),
      response(200, { default_branch: "main" }),
      response(200, { default_branch: "main" }),
      response(204, {}),
      response(200, {}),
    ]);
    globalThis.fetch = fetch;

    await runStageFor("review-matrix", cwd, "12");

    expect(fetch).toHaveBeenCalledTimes(6);
    expect(fetch.mock.calls[4][0]).toContain(
      "/repos/example/repo/actions/workflows/develop.yml/dispatches",
    );
    expect(bodyAt(fetch, 4)).toEqual({
      inputs: { "issue-number": "13" },
      ref: "main",
      return_run_details: true,
    });
    expect(bodyAt(fetch, 5).body).toContain("GitVibe Workflow Queued");
  });
});

describe("stage runner review-fix pull requests", () => {
  it("creates pull requests from review-fix issues on the root branch", async () => {
    const cwd = await workspace();
    mockCreatePrOutput();
    const fetch = fetchMock([
      issueResponse(
        reviewFixIssueMarker({ branch: "git-vibe/7", depth: 1, parent: "7", root: "7" }),
        {
          html_url: "https://github.com/example/repo/issues/8",
          number: 8,
        },
      ),
      commentsResponse([]),
      response(200, { default_branch: "main" }),
      issueResponse("Root issue", {
        html_url: "https://github.com/example/repo/issues/7",
        number: 7,
      }),
      response(200, []),
      response(200, { html_url: "https://github.com/example/repo/pull/22", number: 22 }),
      response(200, {}),
      response(200, {}),
      response(200, {}),
    ]);
    globalThis.fetch = fetch;

    await runStageFor("create-pr", cwd, "8");

    const body = bodyAt(fetch, 5);
    expect(body.head).toBe("git-vibe/7");
    expect(body.body).toContain("Closes #7");
    expect(body.body).toContain("Closes #8");
  });
});

describe("stage runner review-fix investigation", () => {
  it("checks out the root branch before investigating review-fix issues", async () => {
    const cwd = await workspace();
    mockInvestigateOutput();
    const fetch = fetchMock([
      issueResponse(
        reviewFixIssueMarker({ branch: "git-vibe/7", depth: 1, parent: "7", root: "7" }),
        {
          html_url: "https://github.com/example/repo/issues/8",
          number: 8,
        },
      ),
      commentsResponse([]),
      response(200, { default_branch: "main" }),
      response(200, {}),
    ]);
    globalThis.fetch = fetch;

    await expect(runStageFor("investigate", cwd, "8")).resolves.toMatchObject({
      status: "completed",
    });

    expect(currentBranch(cwd)).toBe("git-vibe/7");
    expect(generateText.mock.calls[0][0].prompt).toContain("GitVibe branch: git-vibe/7");
    expect(generateText.mock.calls[0][0].prompt).toContain("GitVibe branch remote found: no");
  });
});

describe("issue branch preparation", () => {
  it("checks out an existing remote issue branch", async () => {
    const cwd = await workspaceWithRemoteIssueBranch();

    await expect(
      prepareIssueBranch({
        baseBranch: "main",
        branch: "git-vibe/12",
        cwd,
        logger: fakeLogger(),
        token: "token",
      }),
    ).resolves.toEqual({ branch: "git-vibe/12", remoteFound: true });

    expect(currentBranch(cwd)).toBe("git-vibe/12");
  });

  it("falls back to the base branch only when the remote issue branch is missing", async () => {
    const cwd = await workspaceWithRemoteIssueBranch();

    await expect(
      prepareIssueBranch({
        baseBranch: "main",
        branch: "git-vibe/99",
        cwd,
        logger: fakeLogger(),
        token: "token",
      }),
    ).resolves.toEqual({ branch: "git-vibe/99", remoteFound: false });

    expect(currentBranch(cwd)).toBe("git-vibe/99");
  });

  it("does not fall back to the base branch when remote branch checkout is blocked", async () => {
    const cwd = await workspaceWithRemoteIssueBranch();
    mkdirSync(join(cwd, ".git-vibe", "handoffs"), { recursive: true });
    writeFileSync(join(cwd, ".git-vibe/handoffs/git-vibe-investigate-result.json"), "local");
    const logger = fakeLogger();

    await expect(
      prepareIssueBranch({
        baseBranch: "main",
        branch: "git-vibe/12",
        cwd,
        logger,
        token: "token",
      }),
    ).rejects.toThrow();

    expect(currentBranch(cwd)).toBe("main");
    expect(logger.event).toHaveBeenCalledWith(
      "git.branch.checkout.failed",
      expect.objectContaining({ branch: "git-vibe/12" }),
    );
  });
});

describe("review-fix deterministic paths", () => {
  it("blocks when review-fix depth exceeds the configured maximum", async () => {
    const client = requestClient([{}, {}]);
    const result = await handleReviewFixRequired({
      client,
      config: { ai: { budgets: { review_max_iterations: 0 } } },
      context: contextWithReviewFix({ depth: 5, issueNumber: "8", parent: "7", root: "7" }),
      logger: fakeLogger(),
      result: stageResult({ next_state: "changes-required" }),
      runner: runnerOptions({ issueNumber: "8", stage: "review-matrix" }),
    });

    expect(result).toMatchObject({ status: "blocked" });
    expect(requestBody(client, 0).body).toContain("review-fix depth 6 exceeds");
    expect(labelRequestBody(client, "gvi:blocked")?.labels).toEqual(["gvi:blocked"]);
  });

  it("surfaces sparse review-fix issue responses after preserving review details", async () => {
    const client = sparseReviewFixClient();

    await expect(
      handleReviewFixRequired({
        client,
        config: {},
        context: contextWithIssue({ title: "" }),
        logger: fakeLogger(),
        result: stageResult({
          comment_body: 123,
          findings: "invalid",
          references: "invalid",
        }),
        runner: runnerOptions({ issueNumber: "12", stage: "review-matrix" }),
      }),
    ).rejects.toThrow("Cannot dispatch review-fix workflow without an issue number");

    expect(requestBody(client, 0).title).toBe("Review fixes for #12: GitVibe implementation");
    expect(requestBody(client, 0).body).toContain("- None provided.");
    expect(client.request.mock.calls[2][0].path).toContain("/sub_issues");
  });

  it("falls back when review-fix workflow dispatch cannot return run details", async () => {
    const client = requestClient([
      { html_url: "https://github.com/example/repo/issues/13", id: 99, number: 13 },
      {},
      {},
      { default_branch: "main" },
      new Error("return_run_details is not a permitted key"),
      {},
      {},
    ]);
    const logger = fakeLogger();

    await expect(
      handleReviewFixRequired({
        client,
        config: {},
        context: contextWithIssue(),
        logger,
        result: stageResult({ next_state: "changes-required" }),
        runner: runnerOptions(),
      }),
    ).resolves.toMatchObject({ status: "completed" });

    expect(requestBody(client, 4)).toEqual({
      inputs: { "issue-number": "13" },
      ref: "main",
      return_run_details: true,
    });
    expect(requestBody(client, 5)).toEqual({
      inputs: { "issue-number": "13" },
      ref: "main",
    });
    expect(requestBody(client, 6).body).not.toContain("Workflow run:");
    expect(logger.event).toHaveBeenCalledWith(
      "github.workflow.dispatch.run_details_unavailable",
      expect.objectContaining({ workflow: "develop.yml" }),
    );
  });

  it("renders traceability without a leading blank body", () => {
    expect(appendIssueTraceability("", ["7", "7", "8"], { closingKeywords: false })).toBe(
      "## GitVibe Traceability\n\nRefs #7\nRefs #8",
    );
  });
});

function mockReviewChanges(overrides = {}) {
  generateText.mockResolvedValueOnce(
    aiOutput({
      assumptions: [],
      comment_body: "Detailed review evidence.",
      findings: ["src/foo.ts: fix required"],
      next_state: "changes-required",
      references: ["Workflow run: https://github.com/example/repo/actions/runs/1"],
      stage: "review-matrix",
      status: "completed",
      summary: "Review found required fixes.",
      tests: ["not run"],
      ...overrides,
    }),
  );
}

function mockCreatePrOutput() {
  generateText.mockResolvedValueOnce(
    aiOutput({
      assumptions: [],
      branch: "git-vibe/7",
      comment_body: "PR ready.",
      findings: [],
      next_state: "pr-draft-ready",
      pr_body: "Implemented review fixes.",
      pr_title: "GitVibe: title",
      references: [],
      stage: "create-pr",
      status: "completed",
      summary: "Created PR.",
    }),
  );
}

function mockInvestigateOutput() {
  generateText.mockResolvedValueOnce(
    aiOutput({
      assumptions: [],
      blocking_questions: [],
      comment_body: "Investigated review-fix branch state.",
      findings: ["git-vibe/7 is checked out for review-fix continuation."],
      implementation_plan: ["Apply the required review fixes on git-vibe/7."],
      next_state: "ready-for-implementation",
      questions: [],
      references: [],
      stage: "investigate",
      status: "completed",
      summary: "Review-fix investigation complete.",
    }),
  );
}

function aiOutput(content) {
  return {
    steps: [
      {
        toolCalls: [{ input: { content: JSON.stringify(content) }, toolName: "output_validator" }],
      },
    ],
    text: "{}",
  };
}

async function runStageFor(stage, cwd, issueNumber) {
  return runStage({
    cwd,
    dryRun: false,
    issueNumber,
    maxTurns: 2,
    prNumber: "",
    repository: "example/repo",
    stage,
    stageTimeoutMinutes: 1,
    token: "token",
  });
}

async function workspace(config = "") {
  const cwd = await mkdtemp(join(tmpdir(), "git-vibe-review-fix-"));
  process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), "git-vibe-runner-"));
  mkdirSync(join(cwd, ".github"));
  writeFileSync(join(cwd, ".github", "git-vibe.yml"), workspaceConfigWithTestAi(config));
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  return cwd;
}

async function workspaceWithRemoteIssueBranch() {
  const origin = await mkdtemp(join(tmpdir(), "git-vibe-origin-"));
  const source = await mkdtemp(join(tmpdir(), "git-vibe-source-"));
  const cwd = await mkdtemp(join(tmpdir(), "git-vibe-clone-"));
  execFileSync("git", ["init", "--bare"], { cwd: origin, stdio: "ignore" });
  execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: origin });
  execFileSync("git", ["init"], { cwd: source, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "main"], { cwd: source, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "tester"], { cwd: source });
  execFileSync("git", ["config", "user.email", "tester@example.com"], { cwd: source });
  writeFileSync(join(source, "README.md"), "base\n");
  execFileSync("git", ["add", "-A"], { cwd: source });
  execFileSync("git", ["commit", "-m", "base"], { cwd: source, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: source });
  execFileSync("git", ["push", "origin", "main"], { cwd: source, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "git-vibe/12"], { cwd: source, stdio: "ignore" });
  mkdirSync(join(source, ".git-vibe", "handoffs"), { recursive: true });
  writeFileSync(join(source, ".git-vibe/handoffs/git-vibe-investigate-result.json"), "remote\n");
  execFileSync("git", ["add", "-A"], { cwd: source });
  execFileSync("git", ["commit", "-m", "tracked handoff"], { cwd: source, stdio: "ignore" });
  execFileSync("git", ["push", "origin", "git-vibe/12"], { cwd: source, stdio: "ignore" });
  execFileSync("git", ["clone", origin, cwd], { stdio: "ignore" });
  execFileSync("git", ["checkout", "main"], { cwd, stdio: "ignore" });
  return cwd;
}

function existingReviewFixLink() {
  return {
    body: reviewFixLinkComment({
      depth: 1,
      issueNumber: "13",
      parent: "12",
      root: "12",
    }),
    created_at: "2026-01-03T00:00:00Z",
    id: 77,
  };
}

function currentBranch(cwd) {
  return execFileSync("git", ["branch", "--show-current"], { cwd }).toString().trim();
}

function fetchMock(responses) {
  return vi.fn(async (url, init = {}) => {
    if (isLabelRequest(url, init)) return response(200, {});
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  });
}

function isLabelRequest(url, init) {
  const method = String(init.method || "GET").toUpperCase();
  const path = String(url);
  return (
    (method === "POST" && /\/issues\/\d+\/labels$/.test(path)) ||
    (method === "DELETE" && path.includes("/labels/"))
  );
}

function bodyAt(fetch, index) {
  return JSON.parse(fetch.mock.calls[index][1].body);
}

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

function commentsResponse(comments) {
  return response(200, comments);
}

function response(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(value),
  };
}

function contextWithReviewFix({ depth, issueNumber, parent, root }) {
  return contextWithIssue({
    body: reviewFixIssueMarker({
      branch: `git-vibe/${root}`,
      depth,
      parent,
      root,
    }),
    issueNumber,
  });
}

function contextWithIssue(overrides = {}) {
  return {
    artifact: {
      body: overrides.body || "Issue body",
      number: overrides.issueNumber || "12",
      title: overrides.title ?? "Issue title",
      type: "issue",
      url: `https://github.com/example/repo/issues/${overrides.issueNumber || "12"}`,
    },
    generatedAt: "2026-01-02T00:00:00Z",
    repository: "example/repo",
    timeline: [],
  };
}

function stageResult(overrides = {}) {
  const parsedOutput = {
    assumptions: [],
    comment_body: "Detailed review evidence.",
    findings: ["src/foo.ts: fix required"],
    next_state: "changes-required",
    references: [],
    stage: "review-matrix",
    status: "completed",
    summary: "Review found required fixes.",
    ...overrides,
  };
  return {
    commentBody: "",
    parsedOutput,
    schemaId: "review-matrix.v1",
    status: String(parsedOutput.status),
    summary: String(parsedOutput.summary),
    validationErrors: [],
  };
}

function runnerOptions(overrides = {}) {
  return {
    cwd: "/tmp/git-vibe",
    dryRun: false,
    issueNumber: "12",
    maxTurns: 2,
    prNumber: "",
    repository: "example/repo",
    stage: "review-matrix",
    stageTimeoutMinutes: 1,
    token: "token",
    ...overrides,
  };
}

function fakeLogger() {
  return { event: vi.fn() };
}

function requestClient(responses) {
  return {
    request: vi.fn(async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next || {};
    }),
  };
}

function sparseReviewFixClient() {
  return {
    request: vi.fn(async (request) => {
      if (request.path === "/repos/example/repo/issues") {
        return { html_url: "https://github.com/example/repo/issues/13", id: 99 };
      }
      if (request.path.includes("/sub_issues")) throw new Error("sub-issues unavailable");
      return {};
    }),
  };
}

function requestBody(client, index) {
  return client.request.mock.calls[index][0].body;
}

function labelRequestBody(client, label) {
  return client.request.mock.calls
    .map((call) => call[0].body)
    .find((body) => body?.labels?.[0] === label);
}
