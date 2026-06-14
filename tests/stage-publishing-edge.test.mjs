// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import {
  publishFeedbackInvestigationReplies,
  publishStageResultComment,
  publishStageStartComment,
} from "../src/runner/stage-publishing.ts";
import { workflowQueuedMarker } from "../src/shared/status-comments.ts";

describe("stage publishing PR reply edge cases", () => {
  it("posts PR review-comment replies when a source review comment id is available", async () => {
    const client = createClient();

    await publishStageResultComment({
      client,
      context: context("pull-request"),
      logger: createLogger(),
      parsedOutput: prInvestigationOutput(),
      runner: runner({
        sourceComment: { id: "88", kind: "pull-request-review-comment" },
        stage: "investigate",
      }),
    });

    expect(requestCalls(client).at(-1)).toMatchObject({
      method: "POST",
      path: "/repos/example/repo/pulls/12/comments/88/replies",
    });
  });

  it("skips feedback replies outside pull requests and when no replies are publishable", async () => {
    const client = createClient();

    await publishFeedbackInvestigationReplies({
      client,
      context: context("issue"),
      logger: createLogger(),
      parsedOutput: {
        feedback_items: [{ id: "review-node", reply: "Already handled.", status: "answered" }],
      },
      runner: runner({ stage: "investigate" }),
    });
    await publishFeedbackInvestigationReplies({
      client,
      context: context("pull-request"),
      logger: createLogger(),
      parsedOutput: { feedback_items: [{ id: "review-node", status: "requires-fix" }] },
      runner: runner({ stage: "investigate" }),
    });

    expect(requestCalls(client)).toEqual([]);
  });
});

describe("stage publishing status cleanup edge cases", () => {
  it("logs transient status cleanup failures and still posts the new comment", async () => {
    const client = createClient();
    const logger = createLogger();
    client.request = vi.fn(async (request) => {
      if (request.method === "DELETE") return Promise.reject("delete unavailable");
      return {};
    });

    await publishStageStartComment({
      client,
      context: {
        ...context("issue"),
        timeline: [
          {
            body: workflowQueuedMarker({
              artifact: "issue",
              number: "12",
              workflow: "validate.yml",
            }),
            author: "git-vibe",
            createdAt: "2026-01-01T00:00:00Z",
            id: "44",
            kind: "comment",
            url: "comment-url",
          },
        ],
      },
      logger,
      runner: runner({ stage: "validate" }),
    });

    expect(logger.event).toHaveBeenCalledWith(
      "github.status_comment.delete.failed",
      expect.objectContaining({ error: "delete unavailable", surface: "issue-comment" }),
    );
    expect(requestCalls(client).at(-1).method).toBe("POST");
  });
});

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

function prInvestigationOutput() {
  return {
    assumptions: [],
    comment_body: "Result body.",
    feedback_items: [],
    findings: [],
    next_state: "no-fixes-needed",
    references: [],
    stage: "investigate",
    status: "completed",
    summary: "Result summary.",
  };
}

function runner(overrides = {}) {
  return {
    cwd: "/repo",
    dryRun: false,
    issueNumber: "12",
    maxTurns: 2,
    prNumber: "12",
    repository: "example/repo",
    stage: "investigate",
    stageTimeoutMinutes: 1,
    token: "token",
    ...overrides,
  };
}

function createClient() {
  return {
    apiBaseUrl: "https://api.github.test",
    graphql: vi.fn(async () => ({})),
    request: vi.fn(async () => ({})),
    retryBaseDelayMs: 0,
  };
}

function createLogger() {
  return { event: vi.fn() };
}

function requestCalls(client) {
  return client.request.mock.calls.map((call) => call[0]);
}
