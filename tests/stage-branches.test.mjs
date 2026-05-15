import { describe, expect, it, vi } from "vitest";
import {
  blockedPullRequestHeadOutput,
  branchForWriteStage,
  issueBranchForStage,
  pullRequestHeadBlockReason,
  runnerBaseBranch,
} from "../src/runner/stage-branches.ts";

describe("stage branch helpers", () => {
  it("resolves pull request and issue branches by stage", () => {
    const prContext = context("pull-request", {
      pullRequestHead: { branch: "feature", repository: "example/repo" },
    });
    const issueContext = context("issue");

    expect(issueBranchForStage("investigate", prContext)).toBe("feature");
    expect(issueBranchForStage("review-matrix", prContext)).toBe("feature");
    expect(branchForWriteStage("address-pr-feedback", prContext)).toBe("feature");
    expect(issueBranchForStage("implement", issueContext)).toBe("git-vibe/12");
    expect(issueBranchForStage("validate", issueContext)).toBeUndefined();
  });

  it("blocks unsafe pull request heads with schema-shaped output", () => {
    const missingHead = context("pull-request");
    const forkHead = context("pull-request", {
      pullRequestHead: { branch: "feature", repository: "fork/repo" },
    });

    expect(pullRequestHeadBlockReason(runner("investigate"), missingHead)).toContain(
      "could not resolve",
    );
    expect(pullRequestHeadBlockReason(runner("address-pr-feedback"), forkHead)).toContain(
      "cannot safely push",
    );
    expect(pullRequestHeadBlockReason(runner("implement"), forkHead)).toBeUndefined();
    expect(blockedPullRequestHeadOutput("investigate", "blocked")).toMatchObject({
      blocking_questions: [
        {
          options: ["Update the pull request to use a branch in this repository."],
          question: "blocked",
        },
      ],
      feedback_items: [],
      next_state: "blocked",
      stage: "investigate",
    });
    expect(blockedPullRequestHeadOutput("address-pr-feedback", "blocked")).toMatchObject({
      skipped_feedback: [],
      tests: [],
    });
  });

  it("uses configured base branches unless default branch is required", async () => {
    const originalBase = process.env.GITVIBE_BASE_BRANCH;
    process.env.GITVIBE_BASE_BRANCH = "release";
    const client = /** @type {import("../src/shared/github.ts").GitHubClient} */ (
      /** @type {unknown} */ ({ request: vi.fn().mockResolvedValue({ default_branch: "main" }) })
    );
    try {
      await expect(runnerBaseBranch(baseBranchOptions(client))).resolves.toMatchObject({
        base: "release",
        targetsDefault: false,
      });
      await expect(
        runnerBaseBranch(baseBranchOptions(client, { requireDefault: true })),
      ).resolves.toMatchObject({
        base: "release",
        defaultBranch: "main",
        targetsDefault: false,
      });
    } finally {
      if (originalBase === undefined) delete process.env.GITVIBE_BASE_BRANCH;
      else process.env.GITVIBE_BASE_BRANCH = originalBase;
    }
  });
});

/**
 * @param {"issue" | "discussion" | "pull-request"} type
 * @param {Partial<import("../src/shared/types.ts").ContextPacket["artifact"]>} [overrides]
 * @returns {import("../src/shared/types.ts").ContextPacket}
 */
function context(type, overrides = {}) {
  return /** @type {import("../src/shared/types.ts").ContextPacket} */ ({
    artifact: {
      body: "",
      number: "12",
      title: "Title",
      type,
      url: `https://github.com/example/repo/${type}/12`,
      ...overrides,
    },
    generatedAt: "2026-01-01T00:00:00Z",
    repository: "example/repo",
    timeline: [],
  });
}

/**
 * @param {import("../src/shared/types.ts").Stage} stage
 * @returns {import("../src/shared/types.ts").RunnerOptions}
 */
function runner(stage) {
  return {
    cwd: "/repo",
    dryRun: false,
    issueNumber: "12",
    maxTurns: 2,
    prNumber: "12",
    repository: "example/repo",
    stage,
    stageTimeoutMinutes: 1,
    token: "token",
  };
}

/**
 * @param {import("../src/shared/github.ts").GitHubClient} client
 * @param {Partial<Parameters<typeof runnerBaseBranch>[0]>} [overrides]
 * @returns {Parameters<typeof runnerBaseBranch>[0]}
 */
function baseBranchOptions(client, overrides = {}) {
  return {
    client,
    logger: { event: vi.fn() },
    options: runner("create-pr"),
    ...overrides,
  };
}
