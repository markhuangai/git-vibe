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
                stage: "implement",
                stages: ["implement", "create-pr"],
              }),
              stage: "implement",
            }),
          ],
        }),
        logger,
        runner: runner({
          acceptedRisk: undefined,
          stage: "implement",
          workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
        }),
      }),
    ).toEqual({
      actor: "maintainer",
      artifactSha: undefined,
      cutoff: "2026-01-04T00:00:00Z",
      run: "99",
      stages: ["implement", "create-pr"],
    });
    expect(logger.event).toHaveBeenCalledWith("accepted_risk.context.detected", {
      cutoff: "2026-01-04T00:00:00Z",
      source: "run-binding",
      stage: "implement",
      stages: "implement,create-pr",
    });
  });

  it("does not use the accept-risk label as runner authority", () => {
    expect(
      acceptedRiskFromContext({
        context: issueContext({
          artifact: { labels: [gitVibeLabels.acceptRisk.name] },
          timeline: [
            blockedResultComment({
              metadata: acceptedRiskMetadata({
                stage: "implement",
                stages: ["implement", "create-pr"],
              }),
              stage: "implement",
            }),
          ],
        }),
        logger: logger(),
        runner: runner({ acceptedRisk: undefined, stage: "implement" }),
      }),
    ).toBeUndefined();
  });
});

describe("accepted-risk workflow run binding rejection", () => {
  it("ignores metadata bound to a different workflow run", () => {
    const loggerMock = logger();

    expect(
      acceptedRiskFromContext({
        context: issueContext({
          timeline: [
            blockedResultComment({
              metadata: acceptedRiskMetadata({
                run: "88",
                stage: "implement",
                stages: ["implement"],
              }),
              stage: "implement",
            }),
          ],
        }),
        logger: loggerMock,
        runner: runner({
          acceptedRisk: undefined,
          stage: "implement",
          workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
        }),
      }),
    ).toBeUndefined();
    expect(loggerMock.event).toHaveBeenCalledWith("accepted_risk.skip", {
      reason: "workflow-run-not-bound",
      run: "99",
      stage: "implement",
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
  author = "github-actions[bot]",
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
