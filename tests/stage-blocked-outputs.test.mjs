import { describe, expect, it } from "vitest";
import { contextCoverageBlockedOutput } from "../src/runner/stage-blocked-outputs.ts";

describe("stage blocked outputs", () => {
  it("builds schema-specific context coverage blocked outputs", () => {
    const stages = /** @type {Array<import("../src/shared/types.ts").Stage>} */ ([
      "investigate",
      "materialize",
      "implement",
      "create-pr",
      "review-matrix",
      "address-pr-feedback",
      "validate",
    ]);
    const outputByStage = Object.fromEntries(
      stages.map((stage) => [
        stage,
        contextCoverageBlockedOutput({
          context: contextPacket(),
          coverage: coverage(22),
          runner: runner(stage),
        }),
      ]),
    );

    expect(outputByStage.investigate).toMatchObject({
      blocking_questions: [expect.any(Object)],
      implementation_plan: [],
    });
    expect(outputByStage.materialize).toMatchObject({ issues: [] });
    expect(outputByStage.implement).toMatchObject({
      branch: "git-vibe/12",
      tests: ["Not run because GitVibe did not process every context chunk."],
    });
    expect(outputByStage["create-pr"]).toMatchObject({
      branch: "git-vibe/12",
      pr_body: "",
      pr_title: "",
    });
    expect(outputByStage["review-matrix"]).toMatchObject({
      inline_comments: [],
      tests: [],
    });
    expect(outputByStage["address-pr-feedback"]).toMatchObject({
      skipped_feedback: expect.arrayContaining(["pending-0"]),
      tests: ["Not run because GitVibe did not process every context chunk."],
    });
    expect(outputByStage.validate).toMatchObject({
      next_state: "blocked",
      questions: [expect.any(Object)],
      stage: "validate",
      status: "blocked",
    });
    expect(outputByStage.validate.comment_body).toContain("...and 2 more");
  });

  it("omits overflow wording when pending chunk preview is complete", () => {
    const output = contextCoverageBlockedOutput({
      context: contextPacket(),
      coverage: coverage(1),
      runner: runner("validate", { workflowRunUrl: undefined }),
    });

    expect(output.comment_body).not.toContain("...and");
    expect(output.references).toEqual(["https://github.com/example/repo/issues/12"]);
  });
});

/**
 * @param {number} pendingCount
 * @returns {import("../src/runner/content-units.ts").ContextPromptCoverage}
 */
function coverage(pendingCount) {
  return /** @type {import("../src/runner/content-units.ts").ContextPromptCoverage} */ ({
    complete: false,
    includedChunkIds: ["artifact-body:chunk-1"],
    pendingChunkIds: Array.from({ length: pendingCount }, (_, index) => `pending-${index}`),
    totalChunks: pendingCount + 1,
  });
}

/** @returns {import("../src/shared/types.ts").ContextPacket} */
function contextPacket() {
  return /** @type {import("../src/shared/types.ts").ContextPacket} */ ({
    artifact: {
      body: "Issue body",
      number: "12",
      title: "Issue title",
      type: "issue",
      url: "https://github.com/example/repo/issues/12",
    },
    generatedAt: "2026-01-02T00:00:00Z",
    repository: "example/repo",
    timeline: [],
  });
}

/**
 * @param {import("../src/shared/types.ts").Stage} stage
 * @param {Partial<import("../src/shared/types.ts").RunnerOptions>} [overrides]
 * @returns {import("../src/shared/types.ts").RunnerOptions}
 */
function runner(stage, overrides = {}) {
  return /** @type {import("../src/shared/types.ts").RunnerOptions} */ ({
    cwd: "/tmp/repo",
    dryRun: false,
    issueNumber: "12",
    maxTurns: 2,
    prNumber: "",
    repository: "example/repo",
    stage,
    stageTimeoutMinutes: 1,
    token: "token",
    workflowRunUrl: "https://github.com/example/repo/actions/runs/1",
    ...overrides,
  });
}
