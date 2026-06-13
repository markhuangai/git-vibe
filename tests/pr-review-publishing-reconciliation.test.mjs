// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { publishStageResultComment } from "../src/runner/stage-publishing.ts";

describe("pull request review publishing thread reconciliation", () => {
  it("replies to an existing GitVibe thread when the same finding still exists", async () => {
    const client = createClient();

    await publishStageResultComment({
      client,
      context: context([priorReviewFinding()]),
      logger: createLogger(),
      parsedOutput: {
        ...output(),
        findings: ["src/app.ts:42 still misses pull_request.labeled."],
        inline_comments: [
          {
            body: "This still misses `pull_request.labeled` handling.",
            finding_id: "review-1",
            line: 42,
            path: "src/app.ts",
          },
        ],
        next_state: "changes-required",
        stage: "review-matrix",
      },
      runner: runner(),
    });

    const reply = requestCalls(client).find((request) =>
      request.path.endsWith("/pulls/12/comments/123/replies"),
    );
    expect(reply.body.body).toContain(
      "<!-- git-vibe:review-finding-update id=review-1 status=still-present sha=abcdef123456 -->",
    );
    expect(reply.body.body).toContain("This issue still exists after commit `abcdef123456`.");
    expect(reply.body.body).toContain("This still misses `pull_request.labeled` handling.");
    expect(reviewRequest(client).body.comments).toBeUndefined();
    expect(client.graphql).not.toHaveBeenCalled();
  });

  it("replies that a prior GitVibe thread is outdated before resolving it", async () => {
    const client = createClient();

    await publishStageResultComment({
      client,
      context: context([priorReviewFinding()]),
      logger: createLogger(),
      parsedOutput: { ...output(), next_state: "review-passed", stage: "review-matrix" },
      runner: runner(),
    });

    const replyIndex = requestCalls(client).findIndex((request) =>
      request.path.endsWith("/pulls/12/comments/123/replies"),
    );
    const reply = requestCalls(client)[replyIndex];
    expect(reply.body.body).toContain(
      "<!-- git-vibe:review-finding-update id=review-1 status=outdated sha=abcdef123456 -->",
    );
    expect(reply.body.body).toContain(
      "This GitVibe finding is outdated after commit `abcdef123456`",
    );
    expect(client.graphql).toHaveBeenCalledWith(
      expect.stringContaining("resolveReviewThread"),
      { threadId: "thread-1" },
      "token",
    );
    expect(client.request.mock.invocationCallOrder[replyIndex]).toBeLessThan(
      client.graphql.mock.invocationCallOrder[0],
    );
  });

  it("does not reconcile review threads authored by someone else", async () => {
    const client = createClient();

    await publishStageResultComment({
      client,
      context: context([priorReviewFinding({ author: "maintainer" })]),
      logger: createLogger(),
      parsedOutput: { ...output(), next_state: "review-passed", stage: "review-matrix" },
      runner: runner(),
    });

    expect(requestCalls(client).map((request) => request.path)).not.toContain(
      "/repos/example/repo/pulls/12/comments/123/replies",
    );
    expect(client.graphql).not.toHaveBeenCalled();
  });
});

describe("pull request review publishing reconciliation edge cases", () => {
  it("does not duplicate an existing finding update reply for the same commit", async () => {
    const client = createClient();
    const logger = createLogger();

    await publishStageResultComment({
      client,
      context: context([priorReviewFinding(), priorFindingUpdateReply()]),
      logger,
      parsedOutput: {
        ...output(),
        findings: ["src/app.ts:42 still misses pull_request.labeled."],
        inline_comments: [
          {
            body: "This still misses `pull_request.labeled` handling.",
            finding_id: "review-1",
            line: 42,
            path: "src/app.ts",
          },
        ],
        next_state: "changes-required",
        stage: "review-matrix",
      },
      runner: runner(),
    });

    expect(requestCalls(client).map((request) => request.path)).not.toContain(
      "/repos/example/repo/pulls/12/comments/123/replies",
    );
    expect(logger.event).toHaveBeenCalledWith("github.pr.review_thread.reply.skip", {
      finding: "review-1",
      reason: "duplicate-update",
      status: "still-present",
    });
  });

  it("uses latest reviewed commit wording when the PR head SHA is unavailable", async () => {
    const client = createClient();

    await publishStageResultComment({
      client,
      context: context([priorReviewFinding()], { pullRequestHead: undefined }),
      logger: createLogger(),
      parsedOutput: { ...output(), next_state: "review-passed", stage: "review-matrix" },
      runner: runner(),
    });

    const reply = requestCalls(client).find((request) =>
      request.path.endsWith("/pulls/12/comments/123/replies"),
    );
    expect(reply.body.body).toContain(
      "<!-- git-vibe:review-finding-update id=review-1 status=outdated sha=latest -->",
    );
    expect(reply.body.body).toContain(
      "This GitVibe finding is outdated after the latest reviewed commit",
    );
  });
});

function context(timeline = [], overrides = {}) {
  return {
    artifact: {
      body: "Body",
      number: "12",
      pullRequestHead:
        "pullRequestHead" in overrides
          ? overrides.pullRequestHead
          : {
              branch: "feature",
              repository: "example/repo",
              sha: "abcdef1234567890abcdef1234567890abcdef12",
            },
      title: "Title",
      type: "pull-request",
      url: "https://github.com/example/repo/pull/12",
    },
    generatedAt: "2026-01-01T00:00:00Z",
    repository: "example/repo",
    timeline,
  };
}

function priorReviewFinding(overrides = {}) {
  return {
    author: "git-vibe",
    body: "<!-- git-vibe:review-finding id=review-1 -->\nOriginal GitVibe finding.",
    createdAt: "2026-01-01T00:00:00Z",
    databaseId: 123,
    id: "review-comment-node",
    kind: "pull-request-review-comment",
    reviewThreadId: "thread-1",
    reviewThreadIsOutdated: false,
    url: "https://github.com/example/repo/pull/12#discussion_r123",
    ...overrides,
  };
}

function priorFindingUpdateReply() {
  return {
    author: "git-vibe",
    body: "<!-- git-vibe:review-finding-update id=review-1 status=still-present sha=abcdef123456 -->\nAlready noted.",
    createdAt: "2026-01-01T00:01:00Z",
    databaseId: 124,
    id: "review-reply-node",
    kind: "pull-request-review-comment",
    parentId: "review-comment-node",
    reviewThreadId: "thread-1",
    reviewThreadIsOutdated: false,
    url: "https://github.com/example/repo/pull/12#discussion_r124",
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

function runner() {
  return {
    cwd: "/repo",
    dryRun: false,
    issueNumber: "12",
    maxTurns: 2,
    prNumber: "12",
    repository: "example/repo",
    stage: "review-matrix",
    stageTimeoutMinutes: 1,
    token: "token",
  };
}

function createClient() {
  return {
    apiBaseUrl: "https://api.github.test",
    graphql: vi.fn(async () => ({})),
    request: vi.fn(async (request) => (request.path === "/user" ? { login: "git-vibe" } : {})),
    retryBaseDelayMs: 0,
  };
}

function createLogger() {
  return { event: vi.fn() };
}

function requestCalls(client) {
  return client.request.mock.calls.map((call) => call[0]);
}

function reviewRequest(client) {
  return requestCalls(client).find((request) => request.path.endsWith("/pulls/12/reviews"));
}
