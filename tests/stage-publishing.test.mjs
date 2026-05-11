import { describe, expect, it, vi } from "vitest";
import {
  applyStageLabelTransition,
  publishFeedbackInvestigationReplies,
  publishStageResultComment,
  publishStageStartComment,
} from "../src/runner/stage-publishing.ts";
import { stageStartMarker, workflowQueuedMarker } from "../src/shared/status-comments.ts";

/**
 * @typedef {import("../src/shared/github.ts").GitHubClient & { graphql: any; request: any }} MockGitHubClient
 * @typedef {import("../src/shared/types.ts").ContextPacket} ContextPacket
 * @typedef {import("../src/shared/types.ts").RunnerOptions} RunnerOptions
 * @typedef {import("../src/shared/types.ts").TimelineItem} TimelineItem
 */

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
});

describe("stage publishing feedback investigation replies", () => {
  it("publishes only to referenced review comments", async () => {
    const client = createClient();
    const prContext = {
      ...context("pull-request"),
      timeline: [
        {
          author: "reviewer",
          body: "Feedback",
          createdAt: "2026-01-01T00:00:00Z",
          databaseId: 99,
          id: "review-node",
          kind: "pull-request-review-comment",
          url: "review-url",
        },
      ],
    };

    await publishFeedbackInvestigationReplies({
      client,
      context: prContext,
      logger: createLogger(),
      parsedOutput: {
        feedback_items: [
          { id: "review-node", reply: "Already handled by the current diff.", status: "answered" },
          { id: "missing-node", reply: "Cannot post this.", status: "rejected" },
          { id: "review-node", reply: "Implementation needed.", status: "requires-fix" },
        ],
      },
      runner: runner({ stage: "investigate" }),
    });

    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { body: "Already handled by the current diff." },
        method: "POST",
        path: "/repos/example/repo/pulls/12/comments/99/replies",
      }),
    );
  });
});

describe("stage publishing helpers", () => {
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

    expect(requestCalls(client)[0].body.body).not.toContain("In reply to:");
    expect(requestCalls(client)[1].body.body).not.toContain("In reply to:");
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

describe("stage publishing discussion replies", () => {
  it("posts discussion reply results to the parent thread when the source is already a reply", async () => {
    const client = createClient();

    await publishStageResultComment({
      client,
      context: {
        ...context("discussion"),
        artifact: { ...context("discussion").artifact, id: "D_1" },
        timeline: [
          timelineItem({ id: "parent-comment", kind: "comment" }),
          timelineItem({ id: "command-reply", kind: "reply", parentId: "parent-comment" }),
        ],
      },
      logger: createLogger(),
      parsedOutput: output(),
      runner: runner({
        sourceComment: { kind: "discussion-comment", nodeId: "command-reply" },
        stage: "summarize",
      }),
    });

    expect(client.graphql).toHaveBeenCalledWith(
      expect.stringContaining("GitVibeAddDiscussionComment"),
      expect.objectContaining({ discussionId: "D_1", replyToId: "parent-comment" }),
      "token",
    );
  });
});

describe("stage publishing status cleanup", () => {
  it("deletes queued issue status comments before posting a running comment", async () => {
    const client = createClient();

    await publishStageStartComment({
      client,
      context: {
        ...context("issue"),
        timeline: [
          {
            body: workflowQueuedMarker({
              artifact: "issue",
              number: "12",
              run: "99",
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
      logger: createLogger(),
      runner: runner({
        stage: "validate",
        workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
      }),
    });

    expect(requestCalls(client).map((request) => [request.method, request.path])).toEqual([
      ["DELETE", "/repos/example/repo/issues/comments/44"],
      ["POST", "/repos/example/repo/issues/12/comments"],
    ]);
  });
});

describe("stage publishing stale status cleanup", () => {
  it("deletes stale transient status comments from other stages before posting a running comment", async () => {
    const client = createClient();
    const oldCreatedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const recentCreatedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    await publishStageStartComment({
      client,
      context: {
        ...context("issue"),
        timeline: [
          {
            body: stageStartMarker({
              artifact: "issue",
              number: "12",
              run: "97",
              stage: "review-matrix",
            }),
            author: "git-vibe",
            createdAt: oldCreatedAt,
            id: "51",
            kind: "comment",
            url: "comment-url",
          },
          {
            body: stageStartMarker({
              artifact: "issue",
              number: "12",
              run: "98",
              stage: "implement",
            }),
            author: "git-vibe",
            createdAt: oldCreatedAt,
            id: "52",
            kind: "comment",
            url: "comment-url",
          },
          {
            body: stageStartMarker({
              artifact: "issue",
              number: "12",
              run: "99",
              stage: "implement",
            }),
            author: "git-vibe",
            createdAt: recentCreatedAt,
            id: "53",
            kind: "comment",
            url: "comment-url",
          },
          {
            body: stageStartMarker({
              artifact: "issue",
              number: "13",
              run: "98",
              stage: "implement",
            }),
            author: "git-vibe",
            createdAt: oldCreatedAt,
            id: "54",
            kind: "comment",
            url: "comment-url",
          },
          {
            body: workflowQueuedMarker({
              artifact: "issue",
              number: "12",
              run: "96",
              workflow: "review-matrix.yml",
            }),
            author: "git-vibe",
            createdAt: oldCreatedAt,
            id: "55",
            kind: "comment",
            url: "comment-url",
          },
        ],
      },
      logger: createLogger(),
      runner: runner({
        stage: "investigate",
        workflowRunUrl: "https://github.com/example/repo/actions/runs/100",
      }),
    });

    expect(requestCalls(client).map((request) => [request.method, request.path])).toEqual([
      ["DELETE", "/repos/example/repo/issues/comments/51"],
      ["DELETE", "/repos/example/repo/issues/comments/52"],
      ["DELETE", "/repos/example/repo/issues/comments/55"],
      ["POST", "/repos/example/repo/issues/12/comments"],
    ]);
  });
});

describe("stage publishing discussion status cleanup", () => {
  it("deletes discussion running comments before posting results", async () => {
    const client = createClient();

    await publishStageResultComment({
      client,
      context: {
        ...context("discussion"),
        artifact: { ...context("discussion").artifact, id: "D_1" },
        timeline: [
          {
            body: stageStartMarker({
              artifact: "discussion",
              number: "12",
              run: "99",
              stage: "summarize",
            }),
            author: "git-vibe",
            createdAt: "2026-01-01T00:00:00Z",
            id: "DC_1",
            kind: "comment",
            url: "comment-url",
          },
        ],
      },
      logger: createLogger(),
      parsedOutput: output(),
      runner: runner({
        stage: "summarize",
        workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
      }),
    });

    expect(client.graphql.mock.calls[0][0]).toContain("GitVibeDeleteDiscussionComment");
    expect(client.graphql.mock.calls[0][1]).toMatchObject({ id: "DC_1" });
    expect(client.graphql.mock.calls[1][0]).toContain("GitVibeAddDiscussionComment");
  });
});

describe("stage publishing status cleanup failures", () => {
  it("ignores already-deleted transient status comments", async () => {
    const client = createClient();
    const logger = createLogger();
    client.request = vi.fn(
      /**
       * @param {any} request
       * @returns {Promise<Record<string, unknown>>}
       */
      async (request) => {
        if (request.method === "DELETE") throw new Error("GitHub API DELETE failed: 404");
        return {};
      },
    );

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

    expect(logger.event).not.toHaveBeenCalledWith(
      "github.status_comment.delete.failed",
      expect.anything(),
    );
    expect(requestCalls(client).at(-1).method).toBe("POST");
  });
});

describe("stage publishing review status cleanup", () => {
  it("deletes pull request review running replies before posting review results", async () => {
    const client = createClient();

    await publishStageResultComment({
      client,
      context: {
        ...context("pull-request"),
        timeline: [
          {
            body: stageStartMarker({
              artifact: "pull-request",
              number: "12",
              run: "99",
              stage: "address-pr-feedback",
            }),
            author: "git-vibe",
            createdAt: "2026-01-01T00:00:00Z",
            databaseId: 77,
            id: "PRRC_node",
            kind: "pull-request-review-comment",
            url: "review-url",
          },
        ],
      },
      logger: createLogger(),
      parsedOutput: output(),
      runner: runner({
        sourceComment: { id: "88", kind: "pull-request-review-comment" },
        stage: "address-pr-feedback",
        workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
      }),
    });

    expect(requestCalls(client).map((request) => [request.method, request.path])).toEqual([
      ["DELETE", "/repos/example/repo/pulls/comments/77"],
      ["POST", "/repos/example/repo/pulls/12/comments/88/replies"],
    ]);
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
      parsedOutput: readyInvestigationOutput(),
      runner: runner({ stage: "investigate" }),
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

    expect(
      requestCalls(client)
        .filter((request) => request.method === "POST")
        .map((request) => request.body.labels[0]),
    ).toEqual([
      "gvi:blocked",
      "gvi:ready-for-approval",
      "gvi:investigated",
      "gvi:in-progress",
      "gvi:pr-opened",
    ]);
    expect(requestCalls(client).map((request) => request.path)).toContain(
      "/repos/example/repo/issues/12/labels/gvi%3Ainvestigating",
    );
    expect(requestCalls(client).map((request) => request.path)).toContain(
      "/repos/example/repo/issues/12/labels/git-vibe%3Ainvestigating",
    );
    expect(requestCalls(client).map((request) => request.path)).toContain(
      "/repos/example/repo/issues/12/labels/gvi%3Ablocked",
    );
    expect(requestCalls(client).map((request) => request.path)).toContain(
      "/repos/example/repo/issues/12/labels/git-vibe%3Ablocked",
    );
    expect(requestCalls(client).map((request) => request.path)).toContain(
      "/repos/example/repo/issues/12/labels/gvi%3Ain-progress",
    );
    expect(requestCalls(client).map((request) => request.path)).toContain(
      "/repos/example/repo/issues/12/labels/git-vibe%3Ain-progress",
    );
    expect(requestCalls(client).map((request) => request.path)).toContain(
      "/repos/example/repo/issues/12/labels/gvi%3Ainvestigated",
    );
    expect(requestCalls(client).map((request) => request.path)).toContain(
      "/repos/example/repo/issues/12/labels/git-vibe%3Ainvestigated",
    );
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
    stage: "summarize",
    status: "completed",
    summary: "Result summary.",
  };
}

function readyInvestigationOutput() {
  return {
    ...output(),
    blocking_questions: [],
    implementation_plan: ["Implement the accepted behavior."],
    next_state: "ready-for-implementation",
    stage: "investigate",
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
    stage: "summarize",
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
    graphql: vi.fn(
      /**
       * @param {string} query
       * @returns {Promise<Record<string, unknown>>}
       */
      async (query) => {
        if (query.includes("GitVibeAddDiscussionComment")) {
          return { addDiscussionComment: { comment: { id: "comment", url: "url" } } };
        }
        return {};
      },
    ),
    request: vi.fn(
      /**
       * @param {any} _request
       * @returns {Promise<Record<string, unknown>>}
       */
      async (_request) => ({}),
    ),
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

/**
 * @param {Partial<TimelineItem>} overrides
 * @returns {TimelineItem}
 */
function timelineItem(overrides) {
  return {
    author: "git-vibe",
    body: "",
    createdAt: "2026-01-01T00:00:00Z",
    id: "timeline-item",
    kind: "comment",
    url: "comment-url",
    ...overrides,
  };
}
