// @ts-nocheck
import { writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { isDirectRun, runDevelop } from "../src/runner/actions/run-develop.ts";

const baseEnv = {
  GITHUB_REPOSITORY: "example/repo",
  GITVIBE_GITHUB_TOKEN: "token",
  GITVIBE_ISSUE_NUMBER: "12",
};

describe("GitVibe develop launcher", () => {
  it("loops from review findings back to implementation before creating a PR", async () => {
    const appendFile = vi.fn();
    const log = vi.fn();
    const runStage = vi
      .fn()
      .mockResolvedValueOnce(stageResult("implement", "implemented"))
      .mockResolvedValueOnce(
        stageResult("review-matrix", "fix review findings", {
          findings: ["src/foo.ts: required fix"],
          next_state: "reviewed",
        }),
      )
      .mockResolvedValueOnce(stageResult("implement", "fixed review findings"))
      .mockResolvedValueOnce(stageResult("review-matrix", "review passed"))
      .mockResolvedValueOnce(stageResult("create-pr", "created pull request"));

    await expect(
      runDevelop({
        appendFile,
        cwd: "/repo",
        env: {
          ...baseEnv,
          GITHUB_SERVER_URL: "https://github.enterprise.test",
          GITHUB_OUTPUT: "/tmp/output",
          GITHUB_RUN_ID: "99",
          GITVIBE_DRY_RUN: "true",
          GITVIBE_HANDOFF_DIR: await mkdtemp(join(tmpdir(), "git-vibe-handoffs-")),
          GITVIBE_IMPLEMENTATION_MAX_TURNS: "40",
          GITVIBE_IMPLEMENTATION_TIMEOUT_MINUTES: "41",
          GITVIBE_MAX_TURNS: "20",
          GITVIBE_PUBLISH_MAX_TURNS: "10",
          GITVIBE_PUBLISH_TIMEOUT_MINUTES: "11",
          GITVIBE_REVIEW_TIMEOUT_MINUTES: "21",
          GITVIBE_REVIEW_MAX_ITERATIONS: "2",
          GITVIBE_SOURCE_COMMENT: JSON.stringify({ kind: "issue-comment", id: "99" }),
        },
        log,
        runStage,
      }),
    ).resolves.toBe(0);

    expect(runStage.mock.calls.map((call) => call[0].stage)).toEqual([
      "implement",
      "review-matrix",
      "implement",
      "review-matrix",
      "create-pr",
    ]);
    expect(runStage.mock.calls[2][0]).toMatchObject({
      dryRun: true,
      handoffDir: runStage.mock.calls[0][0].handoffDir,
      maxTurns: 40,
      sourceComment: { kind: "issue-comment", id: "99" },
      stageTimeoutMinutes: 41,
      validationRepairAttempts: 2,
      validationRepairMaxTurns: 90,
      workflowRunUrl: "https://github.enterprise.test/example/repo/actions/runs/99",
    });
    expect(runStage.mock.calls[3][0]).toMatchObject({
      maxTurns: 20,
      stageTimeoutMinutes: 21,
    });
    expect(runStage.mock.calls[4][0]).toMatchObject({
      maxTurns: 10,
      stageTimeoutMinutes: 11,
    });
    expect(appendFile.mock.calls.map((call) => call[1])).toContain(
      "review-iterations<<GITVIBE_OUTPUT\n1\nGITVIBE_OUTPUT\n",
    );
  });
});

describe("GitVibe develop launcher failure paths", () => {
  it("stops before review when implementation returns a non-completed status", async () => {
    const runStage = vi.fn().mockResolvedValueOnce(
      stageResult("implement", "blocked implementation", {
        next_state: "blocked",
        status: "blocked",
      }),
    );

    await expect(
      runDevelop({
        cwd: await mkdtemp(join(tmpdir(), "git-vibe-develop-")),
        env: baseEnv,
        runStage,
      }),
    ).resolves.toBe(1);

    expect(runStage.mock.calls.map((call) => call[0].stage)).toEqual(["implement"]);
  });

  it("stops when review cannot produce actionable implementation feedback", async () => {
    const runStage = vi
      .fn()
      .mockResolvedValueOnce(stageResult("implement", "implemented"))
      .mockResolvedValueOnce(
        stageResult("review-matrix", "review blocked", {
          next_state: "blocked",
          status: "blocked",
        }),
      );

    await expect(
      runDevelop({
        cwd: await mkdtemp(join(tmpdir(), "git-vibe-develop-")),
        env: baseEnv,
        runStage,
      }),
    ).resolves.toBe(1);

    expect(runStage.mock.calls.map((call) => call[0].stage)).toEqual([
      "implement",
      "review-matrix",
    ]);
  });

  it("treats completed review with no findings as passed", async () => {
    const runStage = vi
      .fn()
      .mockResolvedValueOnce(stageResult("implement", "implemented", {}, { resultFile: false }))
      .mockResolvedValueOnce(
        stageResult(
          "review-matrix",
          "review completed",
          { next_state: "done" },
          { resultFile: false },
        ),
      )
      .mockResolvedValueOnce(
        stageResult("create-pr", "created pull request", {}, { resultFile: false }),
      );

    await expect(
      runDevelop({
        cwd: await mkdtemp(join(tmpdir(), "git-vibe-develop-")),
        env: baseEnv,
        runStage,
      }),
    ).resolves.toBe(0);

    expect(runStage.mock.calls.map((call) => call[0].stage)).toEqual([
      "implement",
      "review-matrix",
      "create-pr",
    ]);
    expect(
      isDirectRun(new URL("../src/runner/actions/run-develop.ts", import.meta.url).href, undefined),
    ).toBe(false);
  });
});

describe("GitVibe develop launcher invalid config", () => {
  it("fails when review findings exhaust the configured loop budget", async () => {
    const error = vi.fn();
    const runStage = vi
      .fn()
      .mockResolvedValueOnce(stageResult("implement", "implemented"))
      .mockResolvedValueOnce(
        stageResult("review-matrix", "fix review findings", {
          findings: ["src/foo.ts: required fix"],
          next_state: "changes-required",
        }),
      );

    await expect(
      runDevelop({
        cwd: await mkdtemp(join(tmpdir(), "git-vibe-develop-")),
        env: { ...baseEnv, GITVIBE_REVIEW_MAX_ITERATIONS: "0" },
        error,
        runStage,
      }),
    ).resolves.toBe(1);

    expect(error).toHaveBeenCalledWith(
      "review-matrix requested changes after 0 review loop iteration(s).",
    );
    expect(isDirectRun("", "/tmp/run-develop.js")).toBe(true);
    expect(isDirectRun(pathToFileURL("/tmp/run-develop.ts").href, "/tmp/run-develop.ts")).toBe(
      true,
    );
    expect(isDirectRun(pathToFileURL("/tmp/run-develop.ts").href, "/tmp/other.ts")).toBe(false);
  });

  it("rejects invalid numeric loop and repair settings", async () => {
    const error = vi.fn();

    await expect(
      runDevelop({
        env: { ...baseEnv, GITVIBE_REVIEW_MAX_ITERATIONS: "-1" },
        error,
        runStage: vi.fn(),
      }),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(
      "GITVIBE_REVIEW_MAX_ITERATIONS must be a non-negative integer.",
    );

    await expect(
      runDevelop({
        env: { ...baseEnv, GITVIBE_VALIDATION_REPAIR_MAX_TURNS: "0" },
        error,
        runStage: vi.fn(),
      }),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(
      "GITVIBE_VALIDATION_REPAIR_MAX_TURNS must be a positive integer.",
    );
  });

  it("reports non-error orchestration failures", async () => {
    const error = vi.fn();

    await expect(
      runDevelop({
        env: baseEnv,
        error,
        runStage: vi.fn().mockRejectedValueOnce("plain failure"),
      }),
    ).resolves.toBe(1);

    expect(error).toHaveBeenCalledWith("plain failure");
  });
});

function stageResult(stage, summary, overrides = {}, options = {}) {
  const resultFile =
    options.resultFile === false
      ? undefined
      : join(tmpdir(), `git-vibe-${stage}-${Math.random()}.json`);
  const parsedOutput = {
    assumptions: [],
    comment_body: summary,
    findings: [],
    next_state: stage === "review-matrix" ? "review-passed" : "completed",
    references: [],
    stage,
    status: "completed",
    summary,
    ...overrides,
  };
  if (resultFile)
    writeFileSync(resultFile, JSON.stringify({ parsedOutput, schemaId: `${stage}.v1`, stage }));
  return {
    commentBody: summary,
    parsedOutput,
    resultFile,
    schemaId: `${stage}.v1`,
    status: parsedOutput.status,
    summary,
    validationErrors: [],
  };
}
