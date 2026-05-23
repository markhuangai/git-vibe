import { describe, expect, it, vi } from "vitest";
import { publishStageResultComment } from "../src/runner/stage-publishing.ts";

/**
 * @typedef {import("../src/shared/github.ts").GitHubClient & { graphql: any; request: any }} MockGitHubClient
 * @typedef {import("../src/shared/types.ts").ContextPacket} ContextPacket
 * @typedef {import("../src/shared/types.ts").RunnerOptions} RunnerOptions
 */

describe("pull request review publishing", () => {
  it("submits review-matrix required fixes as GitHub pull request review comments", async () => {
    const client = createClient();

    await publishStageResultComment({
      client,
      context: context("pull-request"),
      logger: createLogger(),
      parsedOutput: {
        ...output(),
        findings: ["src/app.ts:42 fails when the webhook label arrives on pull_request."],
        inline_comments: [
          {
            body: "This branch misses `pull_request.labeled`, so review labels on PRs never start review.",
            line: 42,
            path: "src/app.ts",
            severity: "high",
          },
          {
            body: "The range should share the same right-side anchor.",
            line: 48,
            path: "src/app.ts",
            start_line: 46,
          },
        ],
        next_state: "changes-required",
        stage: "review-matrix",
        summary: "Review found required changes.",
      },
      runner: runner({
        stage: "review-matrix",
        workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
      }),
    });

    const review = requestCalls(client).find((request) =>
      request.path.endsWith("/pulls/12/reviews"),
    );
    expect(review).toMatchObject({
      body: {
        body: expect.stringContaining("## GitVibe Review Matrix"),
        comments: [
          {
            body: expect.stringContaining("pull_request.labeled"),
            line: 42,
            path: "src/app.ts",
            side: "RIGHT",
          },
          {
            body: "The range should share the same right-side anchor.",
            line: 48,
            path: "src/app.ts",
            side: "RIGHT",
            start_line: 46,
            start_side: "RIGHT",
          },
        ],
        event: "COMMENT",
      },
      method: "POST",
      path: "/repos/example/repo/pulls/12/reviews",
    });
    expect(review.body.body).toContain("Review found required changes.");
    expect(review.body.body).toContain(
      "Workflow run: https://github.com/example/repo/actions/runs/99",
    );
    expect(requestCalls(client).map((request) => request.path)).toContain(
      "/repos/example/repo/issues/12/comments",
    );
  });

  it("does not submit a pull request review when review-matrix passes", async () => {
    const client = createClient();

    await publishStageResultComment({
      client,
      context: context("pull-request"),
      logger: createLogger(),
      parsedOutput: {
        ...output(),
        next_state: "review-passed",
        stage: "review-matrix",
      },
      runner: runner({ stage: "review-matrix" }),
    });

    expect(requestCalls(client).map((request) => request.path)).not.toContain(
      "/repos/example/repo/pulls/12/reviews",
    );
  });
});

describe("pull request review publishing validation", () => {
  it("submits a top-level pull request review when required fixes are not anchorable", async () => {
    const client = createClient();

    await publishStageResultComment({
      client,
      context: context("pull-request"),
      logger: createLogger(),
      parsedOutput: {
        ...output(),
        findings: ["The PR misses the workflow trigger, but the finding is not line-anchored."],
        next_state: "changes-required",
        stage: "review-matrix",
      },
      runner: runner({ stage: "review-matrix" }),
    });

    const review = requestCalls(client).find((request) =>
      request.path.endsWith("/pulls/12/reviews"),
    );
    expect(review.body).toMatchObject({
      body: expect.stringContaining("### Required Fixes"),
      event: "COMMENT",
    });
    expect(review.body.comments).toBeUndefined();
  });

  it("rejects malformed inline comment anchors before creating a pull request review", async () => {
    const cases = /** @type {Array<[unknown, string]>} */ ([
      ["not-array", "review-matrix inline_comments must be an array."],
      [[null], "review-matrix inline_comments[0] must be an object."],
      [[{ body: "Missing path.", line: 4 }], "must define path, line, and body"],
      [
        [{ body: "Invalid range.", line: 4, path: "src/app.ts", start_line: 6 }],
        "start_line must be less than or equal to line",
      ],
    ]);

    for (const [inlineComments, message] of cases) {
      const client = createClient();
      await expect(
        publishStageResultComment({
          client,
          context: context("pull-request"),
          logger: createLogger(),
          parsedOutput: {
            ...output(),
            findings: ["Malformed inline comment."],
            inline_comments: inlineComments,
            next_state: "changes-required",
            stage: "review-matrix",
          },
          runner: runner({ stage: "review-matrix" }),
        }),
      ).rejects.toThrow(message);
      expect(requestCalls(client).map((request) => request.path)).not.toContain(
        "/repos/example/repo/pulls/12/reviews",
      );
    }
  });
});

/**
 * @param {ContextPacket["artifact"]["type"]} type
 * @returns {ContextPacket}
 */
function context(type) {
  return {
    artifact: {
      body: "Body",
      number: "12",
      title: "Title",
      type,
      url: `https://github.com/example/repo/${type}s/12`,
    },
    generatedAt: "2026-01-01T00:00:00Z",
    repository: "example/repo",
    timeline: [],
  };
}

function output() {
  return {
    assumptions: [],
    comment_body: "Result body.",
    findings: [],
    next_state: "ready-for-materialization",
    references: [],
    stage: "materialize",
    status: "completed",
    summary: "Result summary.",
  };
}

/**
 * @param {Partial<RunnerOptions>} [overrides]
 * @returns {RunnerOptions}
 */
function runner(overrides = {}) {
  return {
    cwd: "/repo",
    dryRun: false,
    issueNumber: "12",
    maxTurns: 2,
    prNumber: "12",
    repository: "example/repo",
    stage: "materialize",
    stageTimeoutMinutes: 1,
    token: "token",
    ...overrides,
  };
}

/**
 * @returns {MockGitHubClient}
 */
function createClient() {
  return /** @type {MockGitHubClient} */ ({
    apiBaseUrl: "https://api.github.test",
    graphql: vi.fn(async () => ({})),
    request: vi.fn(async () => ({})),
    retryBaseDelayMs: 0,
  });
}

function createLogger() {
  return {
    event: vi.fn(),
  };
}

/**
 * @param {MockGitHubClient} client
 * @returns {any[]}
 */
function requestCalls(client) {
  return client.request.mock.calls.map(
    /**
     * @param {any[]} call
     */
    (call) => call[0],
  );
}
