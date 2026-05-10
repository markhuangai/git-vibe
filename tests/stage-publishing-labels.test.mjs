import { describe, expect, it, vi } from "vitest";
import { applyStageLabelTransition } from "../src/runner/stage-publishing.ts";

/**
 * @typedef {import("../src/shared/github.ts").GitHubClient & { graphql: any; request: any }} MockGitHubClient
 * @typedef {import("../src/shared/types.ts").ContextPacket} ContextPacket
 * @typedef {import("../src/shared/types.ts").RunnerOptions} RunnerOptions
 */

describe("stage label PR feedback transitions", () => {
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
    ).toEqual(["git-vibe:investigated", "git-vibe:in-progress", "git-vibe:ready-for-approval"]);
    expect(requestCalls(client).map((request) => request.path)).toEqual(
      expect.arrayContaining([
        "/repos/example/repo/issues/12/labels/git-vibe%3Aready-for-approval",
        "/repos/example/repo/issues/12/labels/git-vibe%3Ainvestigating",
        "/repos/example/repo/issues/12/labels/git-vibe%3Ain-progress",
      ]),
    );
  });
});

describe("stage label investigation blocking", () => {
  it("blocks not-ready investigation by adding blocked and removing investigating", async () => {
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
      ["DELETE", "/repos/example/repo/issues/12/labels/git-vibe%3Ainvestigating"],
    ]);
    expect(requestCalls(client)[0].body.labels).toEqual(["git-vibe:blocked"]);
  });

  it("ignores a missing investigating label when blocking not-ready investigation", async () => {
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

    expect(client.request).toHaveBeenCalledTimes(2);
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
      expect.objectContaining({ issue: "12", label: "git-vibe:investigating" }),
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
    stage: "summarize",
    stageTimeoutMinutes: 1,
    token: "token",
    ...overrides,
  };
}

/** @returns {MockGitHubClient} */
function createClient() {
  return /** @type {MockGitHubClient} */ ({
    apiBaseUrl: "https://api.github.test",
    graphql: vi.fn(async () => ({})),
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
