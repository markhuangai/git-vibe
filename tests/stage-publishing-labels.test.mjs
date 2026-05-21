import { describe, expect, it, vi } from "vitest";
import {
  applyStageLabelTransition,
  applyStageStartLabelTransition,
} from "../src/runner/stage-publishing.ts";

/**
 * @typedef {import("../src/shared/github.ts").GitHubClient & { graphql: any; request: any }} MockGitHubClient
 * @typedef {import("../src/shared/types.ts").ContextPacket} ContextPacket
 * @typedef {import("../src/shared/types.ts").RunnerOptions} RunnerOptions
 */

describe("stage label PR feedback transitions", () => {
  it("marks pull request review running when review starts", async () => {
    const client = createClient();

    await applyStageStartLabelTransition({
      client,
      context: context("pull-request"),
      logger: createLogger(),
      runner: runner({ stage: "review-matrix" }),
    });

    expect(
      requestCalls(client)
        .filter((request) => request.method === "POST")
        .map((request) => request.body.labels[0]),
    ).toEqual(["gvi:reviewing"]);
    expect(requestCalls(client).map((request) => request.path)).toEqual(
      expect.arrayContaining([
        "/repos/example/repo/issues/12/labels/gvi%3Aready-for-approval",
        "/repos/example/repo/issues/12/labels/gvi%3Ablocked",
      ]),
    );
  });

  it("moves pull request labels through investigation and review", async () => {
    const client = createClient();
    const prContext = context("pull-request");

    await applyStageLabelTransition({
      client,
      context: prContext,
      logger: createLogger(),
      parsedOutput: { ...output(), next_state: "fixes-required", stage: "investigate" },
      runner: runner({ stage: "investigate" }),
    });
    await applyStageLabelTransition({
      client,
      context: prContext,
      logger: createLogger(),
      parsedOutput: { ...output(), next_state: "feedback-addressed", stage: "address-pr-feedback" },
      runner: runner({ stage: "address-pr-feedback" }),
    });
    await applyStageLabelTransition({
      client,
      context: prContext,
      logger: createLogger(),
      parsedOutput: { ...output(), next_state: "review-passed", stage: "review-matrix" },
      runner: runner({ stage: "review-matrix" }),
    });

    expect(
      requestCalls(client)
        .filter((request) => request.method === "POST")
        .map((request) => request.body.labels[0]),
    ).toEqual(["gvi:investigated", "gvi:in-progress", "gvi:ready-for-approval"]);
    expect(requestCalls(client).map((request) => request.path)).toEqual(
      expect.arrayContaining([
        "/repos/example/repo/issues/12/labels/gvi%3Aready-for-approval",
        "/repos/example/repo/issues/12/labels/gvi%3Ainvestigating",
        "/repos/example/repo/issues/12/labels/gvi%3Ain-progress",
        "/repos/example/repo/issues/12/labels/gvi%3Ainvestigated",
      ]),
    );
  });
});

describe("stage label investigation blocking", () => {
  it("removes in-progress when an issue stage blocks", async () => {
    const client = createClient();

    await applyStageLabelTransition({
      client,
      context: context("issue"),
      logger: createLogger(),
      parsedOutput: { ...output(), status: "blocked" },
      runner: runner({ stage: "implement" }),
    });

    expect(requestCalls(client).map((request) => [request.method, request.path])).toEqual([
      ["DELETE", "/repos/example/repo/issues/12/labels/gvi%3Ain-progress"],
      ["DELETE", "/repos/example/repo/issues/12/labels/git-vibe%3Aapproved"],
      ["POST", "/repos/example/repo/issues/12/labels"],
    ]);
    expect(requestCalls(client).at(-1).body.labels).toEqual(["gvi:blocked"]);
  });

  it("blocks not-ready investigation by adding blocked and removing active labels", async () => {
    const client = createClient();

    await applyStageLabelTransition({
      client,
      context: context("issue"),
      logger: createLogger(),
      parsedOutput: blockedInvestigationOutput(),
      runner: runner({ failOnNotReady: true, stage: "investigate" }),
    });

    expect(requestCalls(client).map((request) => [request.method, request.path])).toEqual([
      ["POST", "/repos/example/repo/issues/12/labels"],
      ["DELETE", "/repos/example/repo/issues/12/labels/gvi%3Ainvestigating"],
      ["DELETE", "/repos/example/repo/issues/12/labels/gvi%3Ain-progress"],
    ]);
    expect(requestCalls(client)[0].body.labels).toEqual(["gvi:blocked"]);
  });

  it("ignores missing active labels when blocking not-ready investigation", async () => {
    const client = createClient();
    client.request = vi.fn(
      /**
       * @param {any} request
       * @returns {Promise<Record<string, unknown>>}
       */
      async (request) => {
        if (request.method === "DELETE") throw new Error("GitHub API DELETE label failed: 404");
        return {};
      },
    );

    await expect(
      applyStageLabelTransition({
        client,
        context: context("issue"),
        logger: createLogger(),
        parsedOutput: blockedInvestigationOutput(),
        runner: runner({ failOnNotReady: true, stage: "investigate" }),
      }),
    ).resolves.toBeUndefined();

    expect(client.request).toHaveBeenCalledTimes(3);
  });

  it("logs and rethrows unexpected investigating label removal failures", async () => {
    const client = createClient();
    const logger = createLogger();
    client.request = vi.fn(
      /**
       * @param {any} request
       * @returns {Promise<Record<string, unknown>>}
       */
      async (request) => {
        if (request.method === "DELETE") throw new Error("delete unavailable");
        return {};
      },
    );

    await expect(
      applyStageLabelTransition({
        client,
        context: context("issue"),
        logger,
        parsedOutput: blockedInvestigationOutput(),
        runner: runner({ failOnNotReady: true, stage: "investigate" }),
      }),
    ).rejects.toThrow("delete unavailable");
    expect(logger.event).toHaveBeenCalledWith(
      "github.issue.label.remove.failed",
      expect.objectContaining({ issue: "12", label: "gvi:investigating" }),
    );
  });
});

describe("discussion stage label transitions", () => {
  it("marks discussions as validating when validation starts", async () => {
    const client = createClient();

    await applyStageStartLabelTransition({
      client,
      context: context("discussion"),
      logger: createLogger(),
      runner: runner({ stage: "validate" }),
    });

    expect(discussionLabelMutations(client, "GitVibeRemoveDiscussionLabel")).toEqual([
      { discussionId: "discussion-node", labelIds: ["resolved-label-node"] },
      { discussionId: "discussion-node", labelIds: ["resolved-label-node"] },
    ]);
    expect(discussionLabelMutations(client, "GitVibeAddDiscussionLabel")).toEqual([
      { discussionId: "discussion-node", labelIds: ["resolved-label-node"] },
    ]);
  });

  it("marks validated discussions after successful validation", async () => {
    const client = createClient();

    await applyStageLabelTransition({
      client,
      context: context("discussion"),
      logger: createLogger(),
      parsedOutput: { ...output(), next_state: "ready-for-implementation", stage: "validate" },
      runner: runner({ stage: "validate" }),
    });

    expect(discussionLabelMutations(client, "GitVibeRemoveDiscussionLabel")).toEqual([
      { discussionId: "discussion-node", labelIds: ["resolved-label-node"] },
      { discussionId: "discussion-node", labelIds: ["resolved-label-node"] },
    ]);
    expect(discussionLabelMutations(client, "GitVibeAddDiscussionLabel")).toEqual([
      { discussionId: "discussion-node", labelIds: ["resolved-label-node"] },
    ]);
  });

  it("marks discussions blocked after validation does not reach approval readiness", async () => {
    const client = createClient();

    await applyStageLabelTransition({
      client,
      context: context("discussion"),
      logger: createLogger(),
      parsedOutput: { ...output(), next_state: "needs-info", stage: "validate" },
      runner: runner({ stage: "validate" }),
    });

    expect(discussionLabelMutations(client, "GitVibeRemoveDiscussionLabel")).toEqual([
      { discussionId: "discussion-node", labelIds: ["resolved-label-node"] },
      { discussionId: "discussion-node", labelIds: ["resolved-label-node"] },
    ]);
    expect(discussionLabelMutations(client, "GitVibeAddDiscussionLabel")).toEqual([
      { discussionId: "discussion-node", labelIds: ["resolved-label-node"] },
    ]);
  });
});

describe("discussion stage label transition guards", () => {
  it("skips discussion label changes without a discussion node id", async () => {
    const client = createClient();
    const logger = createLogger();

    await applyStageLabelTransition({
      client,
      context: context("discussion", { id: undefined }),
      logger,
      parsedOutput: { ...output(), next_state: "ready-for-approval", stage: "validate" },
      runner: runner({ stage: "validate" }),
    });

    expect(client.graphql).not.toHaveBeenCalled();
    expect(logger.event).toHaveBeenCalledWith(
      "github.discussion.label.skip",
      expect.objectContaining({ discussion: "12", reason: "missing-discussion-id" }),
    );
  });

  it("ignores missing discussion labels while removing stale validation labels", async () => {
    const client = createClient();
    client.graphql = vi.fn(async (query) => {
      if (query.includes("GitVibeDiscussionLabelId")) {
        return { repository: { label: { id: "resolved-label-node" } } };
      }
      if (query.includes("GitVibeRemoveDiscussionLabel")) {
        throw new Error("GitHub API DELETE label failed: 404");
      }
      return {};
    });

    await expect(
      applyStageLabelTransition({
        client,
        context: context("discussion"),
        logger: createLogger(),
        parsedOutput: { ...output(), next_state: "ready-for-approval", stage: "validate" },
        runner: runner({ stage: "validate" }),
      }),
    ).resolves.toBeUndefined();

    expect(discussionLabelMutations(client, "GitVibeAddDiscussionLabel")).toEqual([
      { discussionId: "discussion-node", labelIds: ["resolved-label-node"] },
    ]);
  });

  it("logs and rethrows unexpected discussion label removal failures", async () => {
    const client = createClient();
    const logger = createLogger();
    client.graphql = vi.fn(async (query) => {
      if (query.includes("GitVibeDiscussionLabelId")) {
        return { repository: { label: { id: "resolved-label-node" } } };
      }
      if (query.includes("GitVibeRemoveDiscussionLabel")) {
        throw new Error("delete unavailable");
      }
      return {};
    });

    await expect(
      applyStageLabelTransition({
        client,
        context: context("discussion"),
        logger,
        parsedOutput: { ...output(), next_state: "ready-for-approval", stage: "validate" },
        runner: runner({ stage: "validate" }),
      }),
    ).rejects.toThrow("delete unavailable");

    expect(logger.event).toHaveBeenCalledWith(
      "github.discussion.label.remove.failed",
      expect.objectContaining({ error: "delete unavailable", label: "gvi:validating" }),
    );
  });
});

/**
 * @param {ContextPacket["artifact"]["type"]} type
 * @param {Partial<ContextPacket["artifact"]>} [artifactOverrides]
 * @returns {ContextPacket}
 */
function context(type, artifactOverrides = {}) {
  return {
    artifact: {
      body: "Body",
      id: type === "discussion" ? "discussion-node" : undefined,
      number: "12",
      title: "Title",
      type,
      url: `https://github.com/example/repo/${type}s/12`,
      ...artifactOverrides,
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

function blockedInvestigationOutput() {
  return {
    ...output(),
    blocking_questions: ["Choose the config key."],
    implementation_plan: [],
    next_state: "needs-info",
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
    stage: "materialize",
    stageTimeoutMinutes: 1,
    token: "token",
    ...overrides,
  };
}

/** @returns {MockGitHubClient} */
function createClient() {
  return /** @type {MockGitHubClient} */ ({
    apiBaseUrl: "https://api.github.test",
    graphql: vi.fn(async (query) => {
      if (query.includes("GitVibeDiscussionLabelId")) {
        return { repository: { label: { id: "resolved-label-node" } } };
      }
      return {};
    }),
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

/**
 * @param {MockGitHubClient} client
 * @param {string} operation
 * @returns {any[]}
 */
function discussionLabelMutations(client, operation) {
  const variables = [];
  for (const call of client.graphql.mock.calls) {
    if (call[0].includes(operation)) variables.push(call[1]);
  }
  return variables;
}

function createLogger() {
  return { event: vi.fn() };
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
