// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { acceptedRiskApplies, publishAcceptedRiskAudit } from "../src/runner/accepted-risk.ts";

describe("accepted-risk runner scope", () => {
  it("only applies to the accepted stage and current pull request head SHA", () => {
    const logger = { event: vi.fn() };
    const context = pullRequestContext();
    const runner = pullRequestReviewRunner();

    expect(acceptedRiskApplies({ context, logger, runner })).toBe(true);
    expect(
      acceptedRiskApplies({ context, logger, runner: { ...runner, acceptedRisk: undefined } }),
    ).toBe(false);
    expect(
      acceptedRiskApplies({
        context,
        logger,
        runner: { ...runner, stage: "investigate" },
      }),
    ).toBe(false);
    expect(
      acceptedRiskApplies({
        context,
        logger,
        runner: {
          ...runner,
          acceptedRisk: {
            artifactSha: "old-sha",
            cutoff: "2026-01-04T00:00:00Z",
            stages: ["review-matrix"],
          },
        },
      }),
    ).toBe(false);
    expect(
      acceptedRiskApplies({
        context: {
          ...context,
          artifact: {
            ...context.artifact,
            pullRequestHead: { branch: "git-vibe/12", repository: "example/repo" },
          },
        },
        logger,
        runner,
      }),
    ).toBe(false);
    expect(
      acceptedRiskApplies({
        context: issueContext(),
        logger,
        runner: {
          ...runner,
          acceptedRisk: { cutoff: "2026-01-04T00:00:00Z", stages: ["review-matrix"] },
        },
      }),
    ).toBe(true);
    expect(
      acceptedRiskApplies({
        context,
        logger,
        runner: {
          ...runner,
          acceptedRisk: { cutoff: "2026-01-04T00:00:00Z", stages: ["review-matrix"] },
        },
      }),
    ).toBe(false);
    expect(
      acceptedRiskApplies({
        context: issueContext(),
        logger,
        runner: { ...runner, acceptedRisk: { cutoff: "not-a-date", stages: ["review-matrix"] } },
      }),
    ).toBe(false);
    expect(logger.event).toHaveBeenCalledWith(
      "accepted_risk.skip",
      expect.objectContaining({ reason: "pull-request-head-changed" }),
    );
    expect(logger.event).toHaveBeenCalledWith("accepted_risk.skip", {
      reason: "missing-accepted-artifact-sha",
    });
    expect(logger.event).toHaveBeenCalledWith("accepted_risk.skip", {
      reason: "invalid-accepted-risk-cutoff",
    });
  });
});

describe("accepted-risk audit publishing", () => {
  it("publishes issue audits and ignores missing accepted-risk labels", async () => {
    const client = {
      request: vi.fn(async (request) => {
        if (request.method === "DELETE") throw new Error("GitHub API DELETE label failed: 404");
        return {};
      }),
    };

    await publishAcceptedRiskAudit({
      client,
      context: issueContext(),
      logger: logger(),
      result: stageResult(),
      runner: runner({
        acceptedRisk: {
          actor: "bad`actor",
          cutoff: "2026-01-04T00:00:00Z",
          stages: ["investigate"],
        },
      }),
    });

    const comment = client.request.mock.calls.find(([request]) => request.method === "POST")?.[0];
    expect(comment.body.body).toContain("`bad'actor` accepted prompt-injection input risk");
    expect(comment.body.body).toContain("The high-risk findings remain visible");
    expect(client.request.mock.calls.at(-1)[0]).toMatchObject({ method: "DELETE" });
  });

  it("renders unknown actors when accepted-risk metadata is absent", async () => {
    const client = {
      request: vi.fn(async (request) => {
        if (request.method === "DELETE") throw new Error("GitHub API DELETE label failed: 404");
        return {};
      }),
    };

    await publishAcceptedRiskAudit({
      client,
      context: issueContext(),
      logger: logger(),
      runner: runner({ acceptedRisk: undefined, workflowRunUrl: "" }),
    });

    const comment = client.request.mock.calls.find(([request]) => request.method === "POST")?.[0];
    expect(comment.body.body).toContain("`<unknown>` accepted prompt-injection input risk");
    expect(comment.body.body).not.toContain("Workflow run:");
  });

  it("publishes discussion audits and removes the accepted-risk label", async () => {
    const graphql = vi.fn(async (query) => {
      if (query.includes("GitVibeDiscussionLabelId")) {
        return { repository: { label: { id: "label-id" } } };
      }
      if (query.includes("GitVibeAddDiscussionComment")) {
        return { addDiscussionComment: { comment: { id: "comment-id", url: "comment-url" } } };
      }
      return { removeLabelsFromLabelable: { clientMutationId: null } };
    });

    await publishAcceptedRiskAudit({
      client: { graphql },
      context: discussionContext({ id: "discussion-id" }),
      logger: logger(),
      runner: runner({ stage: "validate", workflowRunUrl: "" }),
    });

    const bodies = graphql.mock.calls.map(([, variables]) => variables.body).filter(Boolean);
    expect(bodies.at(-1)).toContain("did not detect high-risk prompt-injection content");
    expect(graphql.mock.calls.at(-1)[1]).toEqual({
      discussionId: "discussion-id",
      labelIds: ["label-id"],
    });
  });

  it("logs discussion audit cleanup skips when the discussion node id is missing", async () => {
    const loggerMock = logger();

    await publishAcceptedRiskAudit({
      client: { graphql: vi.fn() },
      context: discussionContext(),
      logger: loggerMock,
      runner: runner({ stage: "validate" }),
    });

    expect(loggerMock.event).toHaveBeenCalledWith("accepted_risk.audit.skip", {
      reason: "missing-discussion-id",
    });
    expect(loggerMock.event).toHaveBeenCalledWith("accepted_risk.label.remove.skip", {
      reason: "missing-discussion-id",
    });
  });
});

describe("accepted-risk audit dry runs", () => {
  it("does not publish audits or remove labels during dry runs", async () => {
    const client = { request: vi.fn() };
    const loggerMock = logger();

    await publishAcceptedRiskAudit({
      client,
      context: issueContext(),
      logger: loggerMock,
      runner: runner({ dryRun: true }),
    });

    expect(client.request).not.toHaveBeenCalled();
    expect(loggerMock.event).toHaveBeenCalledWith("accepted_risk.audit.skip", {
      reason: "dry-run",
    });
  });
});

describe("accepted-risk audit error handling", () => {
  it("propagates unexpected issue label removal errors after publishing the audit", async () => {
    const client = {
      request: vi.fn(async (request) => {
        if (request.method === "DELETE") throw new Error("label api unavailable");
        return {};
      }),
    };

    await expect(
      publishAcceptedRiskAudit({
        client,
        context: issueContext(),
        logger: logger(),
        runner: runner(),
      }),
    ).rejects.toThrow("label api unavailable");
  });

  it("propagates unexpected discussion label removal errors after publishing the audit", async () => {
    const graphql = vi.fn(async (query) => {
      if (query.includes("GitVibeDiscussionLabelId")) {
        return { repository: { label: { id: "label-id" } } };
      }
      if (query.includes("GitVibeAddDiscussionComment")) {
        return { addDiscussionComment: { comment: { id: "comment-id", url: "comment-url" } } };
      }
      throw new Error("discussion label api unavailable");
    });

    await expect(
      publishAcceptedRiskAudit({
        client: { graphql },
        context: discussionContext({ id: "discussion-id" }),
        logger: logger(),
        runner: runner({ stage: "validate" }),
      }),
    ).rejects.toThrow("discussion label api unavailable");
  });

  it("ignores missing discussion accepted-risk labels after publishing the audit", async () => {
    const graphql = vi.fn(async (query) => {
      if (query.includes("GitVibeDiscussionLabelId")) {
        return { repository: { label: { id: "label-id" } } };
      }
      if (query.includes("GitVibeAddDiscussionComment")) {
        return { addDiscussionComment: { comment: { id: "comment-id", url: "comment-url" } } };
      }
      throw new Error("GitHub API remove discussion label failed: 404");
    });

    await expect(
      publishAcceptedRiskAudit({
        client: { graphql },
        context: discussionContext({ id: "discussion-id" }),
        logger: logger(),
        runner: runner({ stage: "validate" }),
      }),
    ).resolves.toBeUndefined();
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

function pullRequestReviewRunner(overrides = {}) {
  return /** @type {import("../src/shared/types.ts").RunnerOptions} */ ({
    acceptedRisk: {
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
    ...overrides,
  });
}

function pullRequestContext(overrides = {}) {
  return /** @type {import("../src/shared/types.ts").ContextPacket} */ ({
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
  });
}

function issueContext() {
  return {
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
}

function discussionContext(overrides = {}) {
  return {
    artifact: {
      body: "",
      number: "5",
      title: "Discussion title",
      type: "discussion",
      url: "https://github.com/example/repo/discussions/5",
      ...overrides,
    },
    generatedAt: "2026-01-01T00:00:00Z",
    repository: "example/repo",
    timeline: [],
  };
}

function stageResult() {
  return {
    commentBody: "Blocked.",
    parsedOutput: { status: "blocked" },
    schemaId: "investigate.v1",
    status: "blocked",
    summary: "Blocked.",
    validationErrors: [],
  };
}
