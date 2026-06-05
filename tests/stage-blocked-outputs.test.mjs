import { describe, expect, it } from "vitest";
import {
  blockedImplementOutput,
  mcpBlockedOutput,
  zeroMatrixResultsOutput,
} from "../src/runner/stage-blocked-outputs.ts";

describe("stage blocked outputs", () => {
  it("builds schema-specific MCP blocked outputs", () => {
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
    expect(outputByStage.implement).toMatchObject({
      branch: "git-vibe/12",
      tests: ["Not run because required MCP context was unavailable."],
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
      skipped_feedback: ["dense_mem is required but unavailable."],
      tests: ["Not run because required MCP context was unavailable."],
    });
    expect(outputByStage.validate).toMatchObject({
      next_state: "blocked",
      questions: [expect.any(Object)],
      stage: "validate",
      status: "blocked",
    });
  });

  it("builds matrix and implementation validation blocked outputs", () => {
    const context = contextPacket({ url: "" });
    const zeroMatrix = zeroMatrixResultsOutput({
      context,
      expected: 3,
      options: runner("investigate", { workflowRunUrl: undefined }),
    });
    const implement = blockedImplementOutput({
      context: contextPacket(),
      finalError: new Error("final parse failed"),
      firstError: new Error("initial parse failed"),
      options: runner("implement"),
    });

    expect(zeroMatrix).toMatchObject({
      blocking_questions: [expect.any(Object)],
      implementation_plan: [],
      references: [],
      summary: "No investigate matrix member results were available for synthesis. Expected 3.",
    });
    expect(implement).toMatchObject({
      branch: "git-vibe/12",
      findings: [
        "Initial structured output failure: initial parse failed",
        "Finalization failure: final parse failed",
      ],
      next_state: "blocked",
      tests: ["Not run after the implement stage failed to produce schema-valid JSON."],
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
