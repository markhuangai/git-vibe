import { describe, expect, it } from "vitest";
import { mcpBlockedOutput, zeroMatrixResultsOutput } from "../src/runner/stage-blocked-outputs.ts";

describe("stage blocked outputs", () => {
  it("builds schema-specific MCP blocked outputs", () => {
    const stages = /** @type {Array<import("../src/shared/types.ts").Stage>} */ ([
      "investigate",
      "materialize",
      "review-matrix",
      "validate",
    ]);
    const outputByStage = Object.fromEntries(
      stages.map((stage) => [
        stage,
        mcpBlockedOutput({
          context: contextPacket(),
          reason: "dense_mem is required but unavailable.",
          runner: runner(stage),
        }),
      ]),
    );

    expect(outputByStage.investigate).toMatchObject({
      blocking_questions: [expect.any(Object)],
      implementation_plan: [],
    });
    expect(outputByStage.materialize).toMatchObject({ issues: [] });
    expect(outputByStage["review-matrix"]).toMatchObject({
      inline_comments: [],
      tests: [],
    });
    expect(outputByStage.validate).toMatchObject({
      next_state: "blocked",
      questions: [expect.any(Object)],
      stage: "validate",
      status: "blocked",
    });
  });

  it("builds matrix finalization blocked outputs", () => {
    const context = contextPacket({ url: "" });
    const zeroMatrix = zeroMatrixResultsOutput({
      context,
      expected: 3,
      options: runner("investigate", { workflowRunUrl: undefined }),
    });

    expect(zeroMatrix).toMatchObject({
      blocking_questions: [expect.any(Object)],
      implementation_plan: [],
      references: [],
      summary: "No investigate matrix member results were available for synthesis. Expected 3.",
    });
  });
});

/** @param {Partial<import("../src/shared/types.ts").ContextPacket["artifact"]>} [overrides] */
function contextPacket(overrides = {}) {
  return /** @type {import("../src/shared/types.ts").ContextPacket} */ ({
    artifact: {
      body: "Issue body",
      number: "12",
      title: "Issue title",
      type: "issue",
      url: "https://github.com/example/repo/issues/12",
      ...overrides,
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
