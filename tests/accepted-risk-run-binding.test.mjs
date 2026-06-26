// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { acceptedRiskApplies, acceptedRiskFromContext } from "../src/runner/accepted-risk.ts";
import { acceptedRiskMetadataBlock } from "../src/shared/accepted-risk.ts";
import { gitVibeLabels } from "../src/shared/labels.ts";

describe("accepted-risk workflow run binding", () => {
  it("derives accepted risk from trusted metadata bound to the current workflow run", () => {
    const logger = { event: vi.fn() };

    expect(
      acceptedRiskFromContext({
        context: issueContext({
          timeline: [
            blockedResultComment({
              metadata: acceptedRiskMetadata({
                run: "99",
                stage: "materialize",
                stages: ["materialize", "validate"],
              }),
              stage: "materialize",
            }),
          ],
        }),
        logger,
        runner: runner({
          acceptedRisk: undefined,
          stage: "materialize",
          workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
        }),
      }),
    ).toEqual({
      actor: "maintainer",
      artifactSha: undefined,
      cutoff: "2026-01-04T00:00:00Z",
      run: "99",
      stages: ["materialize", "validate"],
    });
    expect(logger.event).toHaveBeenCalledWith("accepted_risk.context.detected", {
      cutoff: "2026-01-04T00:00:00Z",
      source: "run-binding",
      stage: "materialize",
      stages: "materialize,validate",
    });
  });

  it("derives accepted risk from metadata bound to the current workflow attempt", () => {
    const logger = { event: vi.fn() };

    expect(
      acceptedRiskFromContext({
        context: issueContext({
          timeline: [
            blockedResultComment({
              metadata: acceptedRiskMetadata({
                run: "99",
                runAttempt: "3",
                stage: "materialize",
                stages: ["materialize", "validate"],
              }),
              stage: "materialize",
            }),
          ],
        }),
        logger,
        runner: runner({
          acceptedRisk: undefined,
          stage: "materialize",
          workflowRunAttempt: "3",
          workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
        }),
      }),
    ).toMatchObject({
      run: "99",
      runAttempt: "3",
      stages: ["materialize", "validate"],
    });
  });

  it("does not use the accept-risk label as runner authority", () => {
    expect(
      acceptedRiskFromContext({
        context: issueContext({
          artifact: { labels: [gitVibeLabels.acceptRisk.name] },
          timeline: [],
        }),
        logger: logger(),
        runner: runner({ acceptedRisk: undefined, stage: "materialize" }),
      }),
    ).toBeUndefined();
  });
});

describe("accepted-risk workflow run audit binding", () => {
  it("derives accepted risk from audit markers bound to the current workflow attempt", () => {
    expect(
      acceptedRiskFromContext({
        context: issueContext({
          timeline: [
            blockedResultComment({
              metadata: acceptedRiskMetadata({
                stage: "materialize",
                stages: ["materialize", "validate"],
              }),
              stage: "materialize",
            }),
            riskAcceptedAuditComment({ run: "99", runAttempt: "3", stage: "materialize" }),
          ],
        }),
        logger: logger(),
        runner: runner({
          acceptedRisk: undefined,
          stage: "validate",
          workflowRunAttempt: "3",
          workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
        }),
      }),
    ).toMatchObject({
      cutoff: "2026-01-04T00:00:00Z",
      stages: ["materialize", "validate"],
    });
  });
});

describe("accepted-risk previous metadata", () => {
  it("derives accepted risk from previous trusted accepted-risk metadata", () => {
    const metadata = acceptedRiskMetadata({
      run: "88",
      stage: "materialize",
      stages: ["materialize", "validate"],
    });

    expect(
      acceptedRiskFromContext({
        context: issueContext({
          timeline: [blockedResultComment({ metadata, stage: "materialize" })],
        }),
        logger: logger(),
        runner: runner({
          acceptedRisk: undefined,
          stage: "validate",
          workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
        }),
      }),
    ).toEqual({
      actor: "maintainer",
      artifactSha: undefined,
      cutoff: "2026-01-04T00:00:00Z",
      stages: ["materialize", "validate"],
    });
  });

  it("rejects previous pull request accepted-risk metadata after the PR head changes", () => {
    const context = pullRequestContext({
      timeline: [
        blockedResultComment({
          markerArtifact: "pull-request",
          metadata: acceptedRiskMetadata({
            artifact: "pull-request",
            artifactSha: "old-sha",
            number: "12",
            stage: "review-matrix",
            stages: ["review-matrix"],
          }),
          stage: "review-matrix",
        }),
      ],
    });

    expect(
      acceptedRiskFromContext({
        context,
        logger: logger(),
        runner: runner({
          acceptedRisk: undefined,
          issueNumber: "",
          prNumber: "12",
          stage: "review-matrix",
        }),
      }),
    ).toBeUndefined();
  });
});

describe("accepted-risk metadata validation", () => {
  it("ignores metadata whose accepted stage does not match the result marker", () => {
    expect(
      acceptedRiskFromContext({
        context: issueContext({
          timeline: [
            blockedResultComment({
              metadata: acceptedRiskMetadata({
                stage: "validate",
                stages: ["materialize"],
              }),
              stage: "materialize",
            }),
          ],
        }),
        logger: logger(),
        runner: runner({ acceptedRisk: undefined, stage: "materialize" }),
      }),
    ).toBeUndefined();
  });
});

describe("accepted-risk workflow run binding rejection", () => {
  it("uses previous metadata bound to a different workflow run for scan narrowing", () => {
    const loggerMock = logger();

    expect(
      acceptedRiskFromContext({
        context: issueContext({
          timeline: [
            blockedResultComment({
              metadata: acceptedRiskMetadata({
                run: "88",
                stage: "materialize",
                stages: ["materialize"],
              }),
              stage: "materialize",
            }),
          ],
        }),
        logger: loggerMock,
        runner: runner({
          acceptedRisk: undefined,
          stage: "materialize",
          workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
        }),
      }),
    ).toEqual({
      actor: "maintainer",
      artifactSha: undefined,
      cutoff: "2026-01-04T00:00:00Z",
      stages: ["materialize"],
    });
    expect(loggerMock.event).toHaveBeenCalledWith("accepted_risk.context.detected", {
      cutoff: "2026-01-04T00:00:00Z",
      source: "metadata-baseline",
      stage: "materialize",
      stages: "materialize",
    });
  });

  it("rejects explicit accepted risk when the workflow run changes", () => {
    const loggerMock = logger();

    expect(
      acceptedRiskApplies({
        context: issueContext(),
        logger: loggerMock,
        runner: runner({
          acceptedRisk: {
            cutoff: "2026-01-04T00:00:00Z",
            run: "88",
            stages: ["review-matrix"],
          },
          stage: "review-matrix",
          workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
        }),
      }),
    ).toBe(false);
    expect(loggerMock.event).toHaveBeenCalledWith("accepted_risk.skip", {
      accepted_run: "88",
      current_run: "99",
      reason: "workflow-run-changed",
    });
  });

  it("rejects explicit accepted risk when the workflow run attempt changes", () => {
    const loggerMock = logger();

    expect(
      acceptedRiskApplies({
        context: issueContext(),
        logger: loggerMock,
        runner: runner({
          acceptedRisk: {
            cutoff: "2026-01-04T00:00:00Z",
            run: "99",
            runAttempt: "2",
            stages: ["review-matrix"],
          },
          stage: "review-matrix",
          workflowRunAttempt: "3",
          workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
        }),
      }),
    ).toBe(false);
    expect(loggerMock.event).toHaveBeenCalledWith("accepted_risk.skip", {
      accepted_attempt: "2",
      current_attempt: "3",
      reason: "workflow-run-attempt-changed",
    });
  });
});

describe("accepted-risk workflow run audit binding rejection", () => {
  it("falls back to previous metadata when run audit markers lack the current attempt", () => {
    const metadata = acceptedRiskMetadata({ stage: "materialize", stages: ["materialize"] });
    const runnerOptions = runner({
      acceptedRisk: undefined,
      stage: "materialize",
      workflowRunAttempt: "3",
      workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
    });

    expect(
      acceptedRiskFromContext({
        context: issueContext({
          timeline: [
            blockedResultComment({ metadata, stage: "materialize" }),
            riskAcceptedAuditComment({ run: "99", stage: "materialize" }),
          ],
        }),
        logger: logger(),
        runner: runnerOptions,
      }),
    ).toMatchObject({
      cutoff: "2026-01-04T00:00:00Z",
      stages: ["materialize"],
    });
    expect(
      acceptedRiskFromContext({
        context: issueContext({
          timeline: [
            blockedResultComment({ metadata, stage: "materialize" }),
            riskAcceptedAuditComment({ run: "99", runAttempt: "2", stage: "materialize" }),
          ],
        }),
        logger: logger(),
        runner: runnerOptions,
      }),
    ).toMatchObject({
      cutoff: "2026-01-04T00:00:00Z",
      stages: ["materialize"],
    });
  });
});

function logger() {
  return { event: vi.fn() };
}

function runner(overrides = {}) {
  return {
    acceptedRisk: {
      actor: "maintainer",
      cutoff: "2026-01-04T00:00:00Z",
      stages: ["investigate"],
    },
    cwd: "/repo",
    dryRun: false,
    issueNumber: "12",
    maxTurns: 1,
    prNumber: "",
    repository: "example/repo",
    stage: "investigate",
    stageTimeoutMinutes: 1,
    token: "token",
    workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
    ...overrides,
  };
}

function issueContext(overrides = {}) {
  const context = {
    artifact: {
      body: "",
      number: "12",
      title: "Issue title",
      type: "issue",
      url: "https://github.com/example/repo/issues/12",
    },
    generatedAt: "2026-01-01T00:00:00Z",
    repository: "example/repo",
    timeline: [],
  };
  return {
    ...context,
    ...overrides,
    artifact: { ...context.artifact, ...(overrides.artifact || {}) },
  };
}

function pullRequestContext(overrides = {}) {
  const context = {
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
    },
    generatedAt: "2026-01-01T00:00:00Z",
    repository: "example/repo",
    timeline: [],
  };
  return {
    ...context,
    ...overrides,
    artifact: { ...context.artifact, ...(overrides.artifact || {}) },
  };
}

function acceptedRiskMetadata(overrides = {}) {
  return {
    actor: "maintainer",
    artifact: "issue",
    artifactContentSha: "accepted-artifact-content-sha",
    cutoff: "2026-01-04T00:00:00Z",
    number: "12",
    stage: "investigate",
    stages: ["investigate"],
    ...overrides,
  };
}

function blockedResultComment({
  author = "gitvibe-for-github[bot]",
  authorAssociation = "NONE",
  markerArtifact = "issue",
  markerNumber = "12",
  metadata,
  stage = "investigate",
}) {
  return {
    author,
    authorAssociation,
    body: [
      `<!-- git-vibe:stage-result stage=${stage} artifact=${markerArtifact} number=${markerNumber} -->`,
      "## GitVibe Result",
      "",
      "**Status:** `blocked`",
      metadata ? acceptedRiskMetadataBlock(metadata) : "",
    ]
      .filter(Boolean)
      .join("\n"),
    createdAt: "2026-01-02T00:00:00Z",
    id: "100",
    kind: "comment",
    url: "https://github.com/example/repo/issues/12#issuecomment-100",
  };
}

function riskAcceptedAuditComment({ run, runAttempt, stage }) {
  const attemptAttribute = runAttempt ? ` run-attempt=${runAttempt}` : "";
  return {
    author: "gitvibe-for-github[bot]",
    authorAssociation: "NONE",
    body: [
      `<!-- git-vibe:risk-accepted stage=${stage} artifact=issue number=12 run=${run}${attemptAttribute} -->`,
      "## GitVibe Risk Accepted",
    ].join("\n"),
    createdAt: "2026-01-04T00:01:00Z",
    id: "101",
    kind: "comment",
    url: "https://github.com/example/repo/issues/12#issuecomment-101",
  };
}
