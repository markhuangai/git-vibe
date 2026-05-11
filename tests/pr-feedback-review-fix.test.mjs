// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";
import { maybeHandlePullRequestReviewFixRequired } from "../src/runner/pr-feedback-review-fix.ts";
import { pullRequestReviewFixMarker } from "../src/shared/traceability.ts";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("pull request review-fix retries", () => {
  it("queues another address-feedback run when a PR review still needs fixes", async () => {
    process.env.GITVIBE_BASE_BRANCH = "develop";
    const client = recordingClient();

    await expect(
      maybeHandlePullRequestReviewFixRequired({
        client,
        config: {},
        context: contextWithPullRequest(),
        logger: fakeLogger(),
        result: stageResult({ next_state: "changes_required" }),
        runner: runnerOptions(),
        transientComments: [],
      }),
    ).resolves.toMatchObject({ status: "completed" });

    expect(
      requestBodiesFor(client, "POST", "/issues/22/labels").map((body) => body.labels),
    ).toEqual(expect.arrayContaining([["gvi:blocked"], ["gvi:review-fix"]]));
    expect(
      requestBodiesFor(client, "POST", "/actions/workflows/address-feedback.yml/dispatches")[0],
    ).toEqual({
      inputs: { "pr-number": "22" },
      ref: "develop",
      return_run_details: true,
    });
    expect(requestBodiesFor(client, "POST", "/issues/22/comments")[0].body).toContain(
      "## GitVibe Review Matrix",
    );
    expect(requestBodiesFor(client, "POST", "/issues/22/comments")[1].body).toContain(
      "git-vibe:review-fix kind=pull-request pr=22 depth=1",
    );
    expect(requestBodiesFor(client, "POST", "/issues/22/comments")[1].body).toContain(
      "https://github.com/example/repo/actions/runs/44",
    );
  });

  it("stops queuing address-feedback after three PR review-fix iterations", async () => {
    const client = recordingClient();
    const logger = fakeLogger();

    await expect(
      maybeHandlePullRequestReviewFixRequired({
        client,
        config: {},
        context: contextWithPullRequest({
          timeline: [1, 2, 3].map((depth) => ({
            body: pullRequestReviewFixMarker({ depth, pullRequest: "22" }),
            id: String(depth),
            kind: "issue-comment",
          })),
        }),
        logger,
        result: stageResult({ next_state: "changes-required" }),
        runner: runnerOptions(),
        transientComments: [],
      }),
    ).resolves.toMatchObject({
      parsedOutput: expect.objectContaining({ next_state: "blocked" }),
      status: "blocked",
    });

    expect(
      requestBodiesFor(client, "POST", "/actions/workflows/address-feedback.yml/dispatches"),
    ).toEqual([]);
    expect(
      requestBodiesFor(client, "POST", "/issues/22/labels").map((body) => body.labels),
    ).toEqual(expect.arrayContaining([["gvi:blocked"], ["gvi:review-fix"]]));
    expect(logger.event).toHaveBeenCalledWith(
      "github.workflow.dispatch.skip",
      expect.objectContaining({ depth: 4, reason: "pr-review-fix-depth" }),
    );
  });
});

describe("pull request review-fix dispatch boundaries", () => {
  it("skips stages and artifacts outside PR review changes-required results", async () => {
    const client = recordingClient();
    const baseOptions = {
      client,
      config: {},
      logger: fakeLogger(),
      transientComments: [],
    };

    await expect(
      maybeHandlePullRequestReviewFixRequired({
        ...baseOptions,
        context: contextWithPullRequest(),
        result: stageResult({ next_state: "changes-required" }),
        runner: { ...runnerOptions(), stage: "validate" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      maybeHandlePullRequestReviewFixRequired({
        ...baseOptions,
        context: contextWithIssue(),
        result: stageResult({ next_state: "changes-required" }),
        runner: runnerOptions(),
      }),
    ).resolves.toBeUndefined();
    await expect(
      maybeHandlePullRequestReviewFixRequired({
        ...baseOptions,
        context: contextWithPullRequest(),
        result: stageResult({ next_state: "review-passed" }),
        runner: runnerOptions(),
      }),
    ).resolves.toBeUndefined();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("falls back when PR review-fix workflow dispatch cannot return run details", async () => {
    let dispatchAttempts = 0;
    const client = recordingClient((request) => {
      if (request.method === "GET" && request.path === "/repos/example/repo") {
        return { default_branch: "main" };
      }
      if (request.path.includes("/actions/workflows/address-feedback.yml/dispatches")) {
        dispatchAttempts += 1;
        if (dispatchAttempts === 1) throw new Error("return_run_details is not a permitted key");
      }
      return {};
    });
    const logger = fakeLogger();

    await expect(
      maybeHandlePullRequestReviewFixRequired({
        client,
        config: {},
        context: contextWithPullRequest(),
        logger,
        result: stageResult({ next_state: "changes-required" }),
        runner: runnerOptions(),
        transientComments: [],
      }),
    ).resolves.toMatchObject({ status: "completed" });

    expect(
      requestBodiesFor(client, "POST", "/actions/workflows/address-feedback.yml/dispatches"),
    ).toEqual([
      { inputs: { "pr-number": "22" }, ref: "main", return_run_details: true },
      { inputs: { "pr-number": "22" }, ref: "main" },
    ]);
    expect(requestBodiesFor(client, "POST", "/issues/22/comments")[1].body).not.toContain(
      "Workflow run:",
    );
    expect(logger.event).toHaveBeenCalledWith(
      "github.workflow.dispatch.run_details_unavailable",
      expect.objectContaining({ workflow: "address-feedback.yml" }),
    );
  });
});

function contextWithPullRequest(overrides = {}) {
  return {
    artifact: {
      body: overrides.body || "PR body",
      number: "22",
      title: overrides.title ?? "PR title",
      type: "pull-request",
      url: "https://github.com/example/repo/pull/22",
    },
    generatedAt: "2026-01-02T00:00:00Z",
    repository: "example/repo",
    timeline: overrides.timeline || [],
  };
}

function contextWithIssue() {
  return {
    artifact: {
      body: "Issue body",
      number: "22",
      title: "Issue title",
      type: "issue",
      url: "https://github.com/example/repo/issues/22",
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

function runnerOptions() {
  return {
    cwd: "/tmp/git-vibe",
    dryRun: false,
    issueNumber: "",
    maxTurns: 2,
    prNumber: "22",
    repository: "example/repo",
    stage: "review-matrix",
    stageTimeoutMinutes: 1,
    token: "token",
  };
}

function recordingClient(handler = defaultRecordingResponse) {
  return {
    request: vi.fn(async (request) => handler(request)),
  };
}

function defaultRecordingResponse(request) {
  return request.path.includes("/actions/workflows/address-feedback.yml/dispatches")
    ? { html_url: "https://github.com/example/repo/actions/runs/44" }
    : {};
}

function fakeLogger() {
  return { event: vi.fn() };
}

function requestBodiesFor(client, method, pathPart) {
  return client.request.mock.calls
    .map(([request]) => request)
    .filter((request) => request.method === method && request.path.includes(pathPart))
    .map((request) => request.body);
}
