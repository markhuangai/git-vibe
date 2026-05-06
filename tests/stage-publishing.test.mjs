// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import {
  applyStageLabelTransition,
  publishStageResultComment,
} from "../src/runner/stage-publishing.ts";

describe("stage publishing helpers", () => {
  it("skips discussion comments when the discussion node id is missing", async () => {
    const client = createClient();
    const logger = createLogger();

    await publishStageResultComment({
      client,
      context: context("discussion"),
      logger,
      parsedOutput: output(),
      runner: runner({ stage: "summarize" }),
    });

    expect(client.graphql).not.toHaveBeenCalled();
    expect(logger.event).toHaveBeenCalledWith("github.discussion.comment.skip", {
      discussion: "12",
      reason: "missing-discussion-id",
    });
  });

  it("falls back to flat PR comments when a review comment id is unavailable", async () => {
    const client = createClient();

    await publishStageResultComment({
      client,
      context: context("pull-request"),
      logger: createLogger(),
      parsedOutput: output(),
      runner: runner({
        sourceComment: {
          kind: "pull-request-review-comment",
          url: "https://github.com/example/repo/pull/12#discussion_r88",
        },
        stage: "address-pr-feedback",
      }),
    });

    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          body: expect.stringContaining(
            "In reply to: https://github.com/example/repo/pull/12#discussion_r88",
          ),
        }),
        path: "/repos/example/repo/issues/12/comments",
      }),
    );
  });

  it("posts flat issue comments with and without source links", async () => {
    const client = createClient();

    await publishStageResultComment({
      client,
      context: context("issue"),
      logger: createLogger(),
      parsedOutput: output(),
      runner: runner({ sourceComment: undefined, stage: "investigate" }),
    });
    await publishStageResultComment({
      client,
      context: context("issue"),
      logger: createLogger(),
      parsedOutput: output(),
      runner: runner({
        sourceComment: {
          kind: "discussion-comment",
          url: "https://github.com/example/repo/discussions/4#discussioncomment-1",
        },
        stage: "investigate",
      }),
    });

    expect(client.request.mock.calls[0][0].body.body).not.toContain("In reply to:");
    expect(client.request.mock.calls[1][0].body.body).not.toContain("In reply to:");
  });

  it("posts discussion comments without reply metadata when no source exists", async () => {
    const client = createClient();

    await publishStageResultComment({
      client,
      context: {
        ...context("discussion"),
        artifact: { ...context("discussion").artifact, id: "D_1" },
      },
      logger: createLogger(),
      parsedOutput: output(),
      runner: runner({ stage: "summarize" }),
    });

    expect(client.graphql).toHaveBeenCalledWith(
      expect.stringContaining("GitVibeAddDiscussionComment"),
      expect.objectContaining({ discussionId: "D_1", replyToId: null }),
      "token",
    );
  });
});

describe("stage label publishing helpers", () => {
  it("applies only deterministic stage labels", async () => {
    const client = createClient();

    await applyStageLabelTransition({
      client,
      context: context("discussion"),
      logger: createLogger(),
      parsedOutput: output(),
      runner: runner({ stage: "summarize" }),
    });
    await applyStageLabelTransition({
      client,
      context: context("issue"),
      logger: createLogger(),
      parsedOutput: output(),
      runner: runner({ stage: "summarize" }),
    });
    await applyStageLabelTransition({
      client,
      context: context("issue"),
      logger: createLogger(),
      parsedOutput: { ...output(), status: "blocked" },
      runner: runner({ stage: "summarize" }),
    });
    await applyStageLabelTransition({
      client,
      context: context("issue"),
      logger: createLogger(),
      parsedOutput: { ...output(), next_state: "READY" },
      runner: runner({ stage: "validate" }),
    });
    await applyStageLabelTransition({
      client,
      context: context("issue"),
      logger: createLogger(),
      parsedOutput: output(),
      runner: runner({ stage: "implement" }),
    });
    await applyStageLabelTransition({
      client,
      context: context("issue"),
      logger: createLogger(),
      parsedOutput: output(),
      runner: runner({ stage: "create-pr" }),
    });

    expect(client.request.mock.calls.map(([request]) => request.body.labels[0])).toEqual([
      "git-vibe:blocked",
      "git-vibe:ready-for-approval",
      "git-vibe:in-progress",
      "git-vibe:pr-opened",
    ]);
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

function output() {
  return {
    assumptions: [],
    comment_body: "Result body.",
    findings: [],
    next_state: "done",
    references: [],
    stage: "summarize",
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
    stage: "summarize",
    stageTimeoutMinutes: 1,
    token: "token",
    ...overrides,
  };
}

function createClient() {
  return {
    graphql: vi.fn(),
    request: vi.fn(async () => ({})),
  };
}

function createLogger() {
  return {
    event: vi.fn(),
  };
}
