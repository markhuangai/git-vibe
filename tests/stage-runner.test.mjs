// @ts-nocheck
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceConfigWithTestAi } from "./support/ai-config.mjs";

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
  createOpenAI.mockClear();
  createAnthropic.mockClear();
  process.env = {
    ...originalEnv,
    GITVIBE_AI_ENV_JSON: JSON.stringify({
      GITVIBE_AI_API_KEY: "test-key",
      GITVIBE_AI_BASE_URL: "https://proxy.test/v1",
    }),
    GITVIBE_AI_MODEL: "test-model",
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
  it("renders dry-run outputs for materialize and feedback stages", async () => {
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
      parsedOutput: { issue_title: "GitVibe dry run: Discussion title" },
    });

    globalThis.fetch = fetchMock([
      issueResponse("PR body"),
      commentsResponse([]),
      reviewThreadsResponse(),
    ]);
    await expect(
      runStage({
        cwd,
        dryRun: true,
        issueNumber: "",
        maxTurns: 2,
        prNumber: "12",
        repository: "example/repo",
        stage: "address-pr-feedback",
        stageTimeoutMinutes: 1,
        token: "token",
      }),
    ).resolves.toMatchObject({ parsedOutput: { skipped_feedback: [], tests: [] } });
  });
});

describe("stage runner branch dry-runs", () => {
  it("renders dry-run outputs for implementation and pull request stages", async () => {
    const cwd = await workspace();
    delete process.env.RUNNER_TEMP;

    globalThis.fetch = fetchMock([issueResponse("Issue body"), commentsResponse([])]);
    await expect(
      runStage({
        cwd,
        dryRun: true,
        issueNumber: "12",
        maxTurns: 2,
        prNumber: "",
        repository: "example/repo",
        stage: "implement",
        stageTimeoutMinutes: 1,
        token: "token",
      }),
    ).resolves.toMatchObject({ parsedOutput: { tests: [] } });

    globalThis.fetch = fetchMock([issueResponse("Issue body"), commentsResponse([])]);
    await expect(
      runStage({
        cwd,
        dryRun: true,
        issueNumber: "12",
        maxTurns: 2,
        prNumber: "",
        repository: "example/repo",
        stage: "create-pr",
        stageTimeoutMinutes: 1,
        token: "token",
      }),
    ).resolves.toMatchObject({
      parsedOutput: { branch: "git-vibe/12", pr_title: "GitVibe dry run: Issue title" },
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
        stage: "summarize",
        stageTimeoutMinutes: 1,
        token: "token",
      }),
    ).resolves.toMatchObject({
      parsedOutput: { comment_body: "GitVibe dry run for summarize on discussion #5." },
    });
  });
});

describe("stage runner implementation writes", () => {
  it("runs implementation tests and skips git writes when there are no changes", async () => {
    const cwd = await workspace("tests:\n  commands:\n    - 'true'\n");
    commitAll(cwd);
    generateText.mockResolvedValueOnce({
      steps: [
        {
          toolCalls: [
            {
              input: {
                content: JSON.stringify({
                  assumptions: [],
                  comment_body: "No changes.",
                  findings: [],
                  next_state: "changes-ready-for-commit",
                  references: [],
                  stage: "implement",
                  status: "completed",
                  summary: "No changes.",
                  tests: ["true"],
                }),
              },
              toolName: "output_validator",
            },
          ],
        },
      ],
      text: "{}",
    });
    globalThis.fetch = fetchMock([
      issueResponse("Issue body"),
      commentsResponse([]),
      response(200, { default_branch: "main" }),
      response(200, {}),
    ]);

    await expect(
      runStage({
        cwd,
        dryRun: false,
        issueNumber: "12",
        maxTurns: 2,
        prNumber: "",
        repository: "example/repo",
        stage: "implement",
        stageTimeoutMinutes: 1,
        token: "token",
      }),
    ).resolves.toMatchObject({ status: "completed" });
  });
});

describe("stage runner materialize writes", () => {
  it("materializes implementation issues and comments back to the source discussion", async () => {
    const cwd = await workspace();
    process.env.GITVIBE_DISCUSSION_NUMBER = "5";
    generateText.mockResolvedValueOnce({
      steps: [
        {
          toolCalls: [
            {
              input: {
                content: JSON.stringify({
                  assumptions: [],
                  comment_body: "Created issue.",
                  findings: [],
                  issue_body: "Implementation body.",
                  issue_title: "Implement feature",
                  next_state: "implementation-issue-ready",
                  references: [],
                  stage: "materialize",
                  status: "completed",
                  summary: "Materialized.",
                }),
              },
              toolName: "output_validator",
            },
          ],
        },
      ],
      text: "{}",
    });
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
    expect(JSON.parse(fetch.mock.calls[1][1].body).labels).toEqual(["git-vibe:story"]);
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
    generateText.mockResolvedValueOnce({
      steps: [
        {
          toolCalls: [
            {
              input: {
                content: JSON.stringify({
                  assumptions: [],
                  comment_body: "Created issue.",
                  findings: [],
                  issue_body: "",
                  issue_title: "",
                  next_state: "implementation-issue-ready",
                  references: [],
                  stage: "materialize",
                  status: "completed",
                  summary: "Materialized.",
                }),
              },
              toolName: "output_validator",
            },
          ],
        },
      ],
      text: "{}",
    });
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
    expect(JSON.parse(fetch.mock.calls[1][1].body).title).toBe("Implement: Discussion title");
  });
});

describe("stage runner pull request writes", () => {
  it("creates and updates pull requests from structured AI output", async () => {
    const cwd = await workspace();
    process.env.GITVIBE_BASE_BRANCH = "develop";
    await runCreatePr(cwd, [], {
      expectedMethod: "POST",
      expectedPath: "/repos/example/repo/pulls",
      expectedBase: "develop",
    });
    await runCreatePr(cwd, [{ number: 22 }], {
      expectedMethod: "PATCH",
      expectedPath: "/repos/example/repo/pulls/22",
    });
  });

  it("creates pull requests with deterministic fallback fields and repository default base", async () => {
    const cwd = await workspace();
    generateText.mockResolvedValueOnce({
      steps: [
        {
          toolCalls: [
            {
              input: {
                content: JSON.stringify({
                  assumptions: [],
                  branch: "git-vibe/12",
                  comment_body: "",
                  findings: [],
                  next_state: "pr-draft-ready",
                  pr_body: "",
                  pr_title: "",
                  references: [],
                  stage: "create-pr",
                  status: "completed",
                  summary: "Fallback summary.",
                }),
              },
              toolName: "output_validator",
            },
          ],
        },
      ],
      text: "{}",
    });
    const fetch = fetchMock([
      issueResponse("Issue body"),
      commentsResponse([]),
      response(200, { default_branch: "main" }),
      response(200, []),
      response(200, { number: 22 }),
      response(200, {}),
      response(200, {}),
    ]);
    globalThis.fetch = fetch;

    await runStage({
      cwd,
      dryRun: false,
      issueNumber: "12",
      maxTurns: 2,
      prNumber: "",
      repository: "example/repo",
      stage: "create-pr",
      stageTimeoutMinutes: 1,
      token: "token",
    });

    const body = JSON.parse(fetch.mock.calls[4][1].body);
    expect(body).toMatchObject({
      base: "main",
      body: "Fallback summary.\n\n## GitVibe Traceability\n\nCloses #12",
      head: "git-vibe/12",
      title: "GitVibe: Issue title",
    });
  });
});

describe("stage runner write skips and branch validation", () => {
  it("skips deterministic writes for non-completed statuses and rejects invalid branch numbers", async () => {
    const cwd = await workspace();
    generateText.mockResolvedValueOnce({
      steps: [
        {
          toolCalls: [
            {
              input: {
                content: JSON.stringify({
                  assumptions: [],
                  branch: "git-vibe/12",
                  comment_body: "Blocked.",
                  findings: [],
                  next_state: "blocked",
                  pr_body: "Refs #12",
                  pr_title: "GitVibe: blocked",
                  references: [],
                  stage: "create-pr",
                  status: "blocked",
                  summary: "Blocked.",
                }),
              },
              toolName: "output_validator",
            },
          ],
        },
      ],
      text: "{}",
    });
    const fetch = fetchMock([
      issueResponse("Issue body"),
      commentsResponse([]),
      response(200, { default_branch: "main" }),
      response(200, {}),
      response(200, {}),
    ]);
    globalThis.fetch = fetch;

    await expect(
      runStage({
        cwd,
        dryRun: false,
        issueNumber: "12",
        maxTurns: 2,
        prNumber: "",
        repository: "example/repo",
        stage: "create-pr",
        stageTimeoutMinutes: 1,
        token: "token",
      }),
    ).resolves.toMatchObject({ status: "blocked" });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls[3][0]).toContain("/repos/example/repo/issues/12/comments");
    expect(JSON.parse(fetch.mock.calls[4][1].body).labels).toEqual(["git-vibe:blocked"]);

    globalThis.fetch = fetchMock([issueWithoutNumberResponse("Issue body"), commentsResponse([])]);
    await expect(
      runStage({
        cwd,
        dryRun: true,
        issueNumber: "abc",
        maxTurns: 2,
        prNumber: "",
        repository: "example/repo",
        stage: "create-pr",
        stageTimeoutMinutes: 1,
        token: "token",
      }),
    ).rejects.toThrow("GitVibe branch requires a numeric issue number");

    globalThis.fetch = fetchMock([issueWithoutNumberResponse("Issue body"), commentsResponse([])]);
    await expect(
      runStage({
        cwd,
        dryRun: true,
        issueNumber: "",
        maxTurns: 2,
        prNumber: "",
        repository: "example/repo",
        stage: "create-pr",
        stageTimeoutMinutes: 1,
        token: "token",
      }),
    ).rejects.toThrow("GitVibe branch requires a numeric issue number, got <missing>");
  });
});

async function runCreatePr(cwd, existingPulls, expected) {
  generateText.mockResolvedValueOnce({
    steps: [
      {
        toolCalls: [
          {
            input: {
              content: JSON.stringify({
                assumptions: [],
                branch: "git-vibe/12",
                comment_body: "PR ready.",
                findings: [],
                next_state: "pr-draft-ready",
                pr_body: "Refs #12",
                pr_title: "GitVibe: title",
                references: [],
                stage: "create-pr",
                status: "completed",
                summary: "Created PR.",
              }),
            },
            toolName: "output_validator",
          },
        ],
      },
    ],
    text: "{}",
  });
  const fetch = fetchMock([
    issueResponse("Issue body"),
    commentsResponse([]),
    response(200, { default_branch: "main" }),
    response(200, existingPulls),
    response(200, { html_url: "https://github.com/example/repo/pull/22", number: 22 }),
    response(200, {}),
    response(200, {}),
  ]);
  globalThis.fetch = fetch;

  await runStage({
    cwd,
    dryRun: false,
    issueNumber: "12",
    maxTurns: 2,
    prNumber: "",
    repository: "example/repo",
    stage: "create-pr",
    stageTimeoutMinutes: 1,
    token: "token",
  });

  expect(fetch.mock.calls[4][0]).toContain(expected.expectedPath);
  expect(fetch.mock.calls[4][1].method).toBe(expected.expectedMethod);
  if (expected.expectedBase)
    expect(JSON.parse(fetch.mock.calls[4][1].body).base).toBe(expected.expectedBase);
}

async function workspace(config = "") {
  const cwd = await mkdtemp(join(tmpdir(), "git-vibe-stage-"));
  process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), "git-vibe-runner-"));
  mkdirSync(join(cwd, ".github"));
  writeFileSync(join(cwd, ".github", "git-vibe.yml"), workspaceConfigWithTestAi(config));
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  return cwd;
}

function commitAll(cwd) {
  execFileSync("git", ["config", "user.name", "tester"], { cwd });
  execFileSync("git", ["config", "user.email", "tester@example.com"], { cwd });
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "-m", "initial"], { cwd, stdio: "ignore" });
}

function fetchMock(responses) {
  return vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  });
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

function issueWithoutNumberResponse(body) {
  return response(200, {
    body,
    created_at: "2026-01-02T00:00:00Z",
    html_url: "https://github.com/example/repo/issues/abc",
    title: "Issue title",
    user: { login: "octocat" },
  });
}

function commentsResponse(comments) {
  return response(200, comments);
}

function reviewThreadsResponse() {
  return graphqlResponse({ repository: { pullRequest: { reviewThreads: { nodes: [] } } } });
}

function discussionResponse() {
  return graphqlResponse({
    repository: {
      discussion: {
        author: { login: "octocat" },
        body: "Discussion body",
        comments: {
          nodes: [{ id: "discussion-parent-comment", replies: { nodes: [commandReply()] } }],
        },
        createdAt: "2026-01-02T00:00:00Z",
        id: "discussion-id",
        title: "Discussion title",
        url: "https://github.com/example/repo/discussions/5",
      },
    },
  });
}

function commandReply() {
  return { id: "discussion-command-reply" };
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
