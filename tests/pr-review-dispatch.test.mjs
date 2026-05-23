// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchPullRequestReviewWorkflow } from "../src/runner/pr-review-dispatch.ts";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("pull request review workflow dispatch", () => {
  it("requires a pull request context", async () => {
    await expect(
      dispatchPullRequestReviewWorkflow({
        client: recordingClient(),
        config: {},
        context: {
          ...contextWithPullRequest(),
          artifact: { ...contextWithPullRequest().artifact, type: "issue" },
        },
        logger: fakeLogger(),
        runner: runnerOptions(),
      }),
    ).rejects.toThrow("Cannot dispatch PR review workflow without a pull request context.");
  });

  it("dispatches review.yml with configured review budgets after feedback changes", async () => {
    process.env.GITVIBE_BASE_BRANCH = "dev";
    const client = recordingClient();

    await dispatchPullRequestReviewWorkflow({
      client,
      config: {
        ai: {
          budgets: {
            default_max_turns: 90,
            default_timeout_minutes: 60,
            review_timeout_minutes: 61,
          },
        },
      },
      context: contextWithPullRequest(),
      logger: fakeLogger(),
      runner: runnerOptions(),
    });

    expect(requestBodiesFor(client, "POST", "/actions/workflows/review.yml/dispatches")[0]).toEqual(
      {
        inputs: { "pr-number": "22", max_turns: "90", timeout_minutes: "61" },
        ref: "dev",
        return_run_details: true,
      },
    );
    expect(requestBodiesFor(client, "POST", "/issues/22/comments")[0].body).toContain(
      "GitVibe queued `review.yml` for pull request #22 after addressing feedback.",
    );
    expect(requestBodiesFor(client, "POST", "/issues/22/comments")[0].body).toContain(
      "https://github.com/example/repo/actions/runs/77",
    );
  });

  it("falls back when review dispatch cannot return run details", async () => {
    let dispatchAttempts = 0;
    const client = recordingClient((request) => {
      if (request.method === "GET" && request.path === "/repos/example/repo") {
        return { default_branch: "main" };
      }
      if (request.path.includes("/actions/workflows/review.yml/dispatches")) {
        dispatchAttempts += 1;
        if (dispatchAttempts === 1) throw new Error("return_run_details is not a permitted key");
      }
      return {};
    });
    const logger = fakeLogger();

    await dispatchPullRequestReviewWorkflow({
      client,
      config: {},
      context: contextWithPullRequest(),
      logger,
      runner: runnerOptions(),
    });

    expect(requestBodiesFor(client, "POST", "/actions/workflows/review.yml/dispatches")).toEqual([
      { inputs: { "pr-number": "22" }, ref: "main", return_run_details: true },
      { inputs: { "pr-number": "22" }, ref: "main" },
    ]);
    expect(requestBodiesFor(client, "POST", "/issues/22/comments")[0].body).not.toContain(
      "Workflow run:",
    );
    expect(logger.event).toHaveBeenCalledWith(
      "github.workflow.dispatch.run_details_unavailable",
      expect.objectContaining({ workflow: "review.yml" }),
    );
  });
});

function contextWithPullRequest() {
  return {
    artifact: {
      body: "PR body",
      number: "22",
      title: "PR title",
      type: "pull-request",
      url: "https://github.com/example/repo/pull/22",
    },
    generatedAt: "2026-01-02T00:00:00Z",
    repository: "example/repo",
    timeline: [],
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
    stage: "address-pr-feedback",
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
  return request.path.includes("/actions/workflows/review.yml/dispatches")
    ? { html_url: "https://github.com/example/repo/actions/runs/77" }
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
