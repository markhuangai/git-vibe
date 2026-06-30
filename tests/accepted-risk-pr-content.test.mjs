// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { acceptedRiskApplies } from "../src/runner/accepted-risk.ts";
import { acceptedRiskArtifactContentSha } from "../src/shared/accepted-risk.ts";

describe("accepted-risk runner pull request content scope", () => {
  it("uses artifact content hashes across pull request head changes", () => {
    const logger = { event: vi.fn() };
    const context = pullRequestContext();
    const runner = pullRequestReviewRunner();

    expect(acceptedRiskApplies({ context, logger, runner: legacyRunner(runner) })).toBe(false);
    expect(acceptedRiskApplies({ context, logger, runner: contentOnlyRunner(runner) })).toBe(false);
    expect(acceptedRiskApplies({ context: contextWithoutHeadSha(context), logger, runner })).toBe(
      false,
    );
    expect(
      acceptedRiskApplies({
        context: pullRequestContext({
          pullRequestHead: {
            branch: "git-vibe/12",
            repository: "example/repo",
            sha: "new-sha",
          },
        }),
        logger,
        runner,
      }),
    ).toBe(true);
    expect(
      acceptedRiskApplies({
        context: pullRequestContext({ body: "Changed body" }),
        logger,
        runner,
      }),
    ).toBe(false);
    expect(
      acceptedRiskApplies({
        context: pullRequestContext({
          body: "Changed body",
          pullRequestHead: {
            branch: "git-vibe/12",
            repository: "example/repo",
            sha: "new-sha",
          },
        }),
        logger,
        runner,
      }),
    ).toBe(false);
    expect(logger.event).toHaveBeenCalledWith(
      "accepted_risk.skip",
      expect.objectContaining({ reason: "pull-request-head-changed" }),
    );
    expect(logger.event).toHaveBeenCalledWith("accepted_risk.skip", {
      reason: "pull-request-artifact-content-changed",
    });
    expect(logger.event).toHaveBeenCalledWith("accepted_risk.skip", {
      reason: "missing-accepted-artifact-sha",
    });
  });
});

function legacyRunner(runner) {
  return {
    ...runner,
    acceptedRisk: {
      artifactSha: "old-sha",
      cutoff: "2026-01-04T00:00:00Z",
      stages: ["review-matrix"],
    },
  };
}

function contentOnlyRunner(runner) {
  return {
    ...runner,
    acceptedRisk: {
      ...runner.acceptedRisk,
      artifactSha: undefined,
    },
  };
}

function contextWithoutHeadSha(context) {
  return {
    ...context,
    artifact: {
      ...context.artifact,
      pullRequestHead: { branch: "git-vibe/12", repository: "example/repo" },
    },
  };
}

function pullRequestReviewRunner() {
  return {
    acceptedRisk: {
      artifactContentSha: acceptedRiskArtifactContentSha({ body: "", title: "PR title" }),
      artifactSha: "current-sha",
      cutoff: "2026-01-04T00:00:00Z",
      stages: ["review-matrix"],
    },
    cwd: "/repo",
    dryRun: false,
    issueNumber: "",
    maxTurns: 1,
    prNumber: "12",
    repository: "example/repo",
    stage: "review-matrix",
    stageTimeoutMinutes: 1,
    token: "token",
  };
}

function pullRequestContext(overrides = {}) {
  return {
    artifact: {
      body: "",
      number: "12",
      pullRequestHead: {
        branch: "git-vibe/12",
        repository: "example/repo",
        sha: "current-sha",
      },
      title: "PR title",
      type: "pull-request",
      url: "https://github.com/example/repo/pull/12",
      ...overrides,
    },
    generatedAt: "2026-01-01T00:00:00Z",
    repository: "example/repo",
    timeline: [],
  };
}
