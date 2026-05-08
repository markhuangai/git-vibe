// @ts-nocheck
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.fn();
const createOpenAI = vi.fn(() => ({ chat: vi.fn(() => "openai-model") }));
const createAnthropic = vi.fn(() => ({ languageModel: vi.fn(() => "anthropic-model") }));

vi.mock("ai", () => ({
  generateText,
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
    GITVIBE_AI_API_KEY: "test-key",
    GITVIBE_AI_BASE_URL: "https://proxy.test/v1",
    GITVIBE_AI_MODEL: "test-model",
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
    expect(startBody).toContain("<!-- git-vibe:stage-start stage=validate");
    expect(startBody).toContain("Workflow run: https://github.com/example/repo/actions/runs/99");
    expect(commentBody).toContain("<!-- git-vibe:stage-result stage=validate");
    expect(commentBody).toContain("Workflow run: https://github.com/example/repo/actions/runs/99");
    expect(JSON.parse(fetch.mock.calls[4][1].body).labels).toEqual(["git-vibe:ready-for-approval"]);
  });

  it("publishes summarize results back to the source discussion", async () => {
    const cwd = await workspace();
    process.env.GITVIBE_DISCUSSION_NUMBER = "5";
    generateText.mockResolvedValueOnce(aiResult(summarizeOutput()));
    const fetch = fetchMock([
      discussionResponse(),
      graphqlResponse({ addDiscussionComment: { comment: { id: "comment", url: "url" } } }),
    ]);
    globalThis.fetch = fetch;

    await runStage({
      cwd,
      dryRun: false,
      issueNumber: "",
      maxTurns: 2,
      prNumber: "",
      repository: "example/repo",
      sourceComment: {
        kind: "discussion-comment",
        nodeId: "discussion-command-comment",
      },
      stage: "summarize",
      stageTimeoutMinutes: 1,
      token: "token",
    });

    const variables = JSON.parse(fetch.mock.calls[1][1].body).variables;
    expect(variables.discussionId).toBe("discussion-id");
    expect(variables.replyToId).toBe("discussion-command-comment");
    expect(variables.body).toContain("## GitVibe Discussion Summary");
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

    expect(fetch.mock.calls[3][0]).toContain("/repos/example/repo/issues/12/comments");
    expect(JSON.parse(fetch.mock.calls[3][1].body).body).toContain("## GitVibe PR Feedback Update");
    expect(JSON.parse(fetch.mock.calls[3][1].body).body).toContain(
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

    expect(fetch.mock.calls[3][0]).toContain("/repos/example/repo/pulls/12/comments/88/replies");
    expect(JSON.parse(fetch.mock.calls[3][1].body).body).toContain("## GitVibe PR Feedback Update");
  });
});

async function workspace(config = "") {
  const cwd = await mkdtemp(join(tmpdir(), "git-vibe-publish-"));
  process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), "git-vibe-runner-"));
  mkdirSync(join(cwd, ".github"));
  writeFileSync(join(cwd, ".github", "git-vibe.yml"), config);
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  return cwd;
}

function commitAll(cwd) {
  execFileSync("git", ["config", "user.name", "tester"], { cwd });
  execFileSync("git", ["config", "user.email", "tester@example.com"], { cwd });
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "-m", "initial"], { cwd, stdio: "ignore" });
}

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
    next_state: "git-vibe:ready-for-approval",
    questions: [],
    references: [],
    stage: "validate",
    status: "completed",
    summary: "Validation complete.",
  };
}

function summarizeOutput() {
  return {
    assumptions: [],
    comment_body: "Summarized discussion.",
    findings: ["Users want the full product flow."],
    next_state: "git-vibe:ready",
    references: [],
    stage: "summarize",
    status: "completed",
    summary: "Discussion is ready.",
  };
}

function feedbackOutput() {
  return {
    assumptions: [],
    comment_body: "Feedback addressed.",
    findings: ["No code changes were needed."],
    next_state: "done",
    references: [],
    skipped_feedback: [],
    stage: "address-pr-feedback",
    status: "completed",
    summary: "PR feedback handled.",
    tests: [],
  };
}

function fetchMock(responses) {
  return vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  });
}

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

function discussionResponse() {
  return graphqlResponse({
    repository: {
      discussion: {
        author: { login: "octocat" },
        body: "Discussion body",
        comments: { nodes: [] },
        createdAt: "2026-01-02T00:00:00Z",
        id: "discussion-id",
        title: "Discussion title",
        url: "https://github.com/example/repo/discussions/5",
      },
    },
  });
}

function graphqlResponse(data) {
  return response(200, { data });
}

function response(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(value),
  };
}
