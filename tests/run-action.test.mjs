// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { isDirectRun, runAction } from "../src/actions/run-action.ts";

const baseEnv = {
  GITHUB_REPOSITORY: "example/repo",
  GITVIBE_GITHUB_TOKEN: "token",
  GITVIBE_ISSUE_NUMBER: "12",
};

describe("GitVibe action launcher", () => {
  it("runs a stage, logs output, and writes GitHub outputs", async () => {
    const appendFile = vi.fn();
    const log = vi.fn();
    const runStage = vi.fn().mockResolvedValue({
      commentBody: "Long body",
      parsedOutput: {},
      schemaId: "investigate.v1",
      status: "completed",
      summary: "Done",
      validationErrors: [],
    });

    await expect(
      runAction({
        appendFile,
        argv: ["investigate"],
        cwd: "/repo",
        env: {
          ...baseEnv,
          GITHUB_OUTPUT: "/tmp/output",
          GITVIBE_DRY_RUN: "true",
          GITVIBE_MAX_TURNS: "12",
          GITVIBE_STAGE_TIMEOUT_MINUTES: "34",
        },
        log,
        runStage,
      }),
    ).resolves.toBe(0);

    expect(runStage).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true,
        issueNumber: "12",
        maxTurns: 12,
        repository: "example/repo",
        stage: "investigate",
        stageTimeoutMinutes: 34,
      }),
    );
    expect(log).toHaveBeenCalledWith("investigate status=completed");
    expect(appendFile.mock.calls.map((call) => call[1])).toEqual([
      "summary<<GITVIBE_OUTPUT\nDone\nGITVIBE_OUTPUT\n",
      "status<<GITVIBE_OUTPUT\ncompleted\nGITVIBE_OUTPUT\n",
      "comment-body<<GITVIBE_OUTPUT\nLong body\nGITVIBE_OUTPUT\n",
    ]);
  });
});

describe("GitVibe action launcher validation", () => {
  it("validates required env and target inputs", async () => {
    const error = vi.fn();
    await expect(runAction({ argv: ["investigate"], env: {}, error })).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("GITVIBE_GITHUB_TOKEN is required.");

    await expect(
      runAction({
        argv: ["summarize"],
        env: baseEnv,
        error,
      }),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("GITVIBE_DISCUSSION_NUMBER is required for this stage.");

    await expect(
      runAction({
        argv: ["validate"],
        env: {
          GITHUB_REPOSITORY: "example/repo",
          GITVIBE_GITHUB_TOKEN: "token",
          GITVIBE_MAX_TURNS: "0",
          GITVIBE_ISSUE_NUMBER: "1",
        },
        error,
      }),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("GITVIBE_MAX_TURNS must be a positive number.");

    await expect(
      runAction({
        argv: ["investigate"],
        env: { GITVIBE_GITHUB_TOKEN: "token", GITVIBE_ISSUE_NUMBER: "1" },
        error,
      }),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("GITHUB_REPOSITORY is required.");

    await expect(
      runAction({
        argv: ["missing-stage"],
        env: baseEnv,
        error,
      }),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("Unknown GitVibe action stage: missing-stage");

    await expect(
      runAction({
        argv: ["address-pr-feedback"],
        env: { GITHUB_REPOSITORY: "example/repo", GITVIBE_GITHUB_TOKEN: "token" },
        error,
      }),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("GITVIBE_PR_NUMBER is required for address-pr-feedback.");

    await expect(
      runAction({
        argv: ["validate"],
        env: { GITHUB_REPOSITORY: "example/repo", GITVIBE_GITHUB_TOKEN: "token" },
        error,
      }),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(
      "GITVIBE_ISSUE_NUMBER or GITVIBE_DISCUSSION_NUMBER is required for validate.",
    );

    await expect(
      runAction({
        argv: ["implement"],
        env: { GITHUB_REPOSITORY: "example/repo", GITVIBE_GITHUB_TOKEN: "token" },
        error,
      }),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("GITVIBE_ISSUE_NUMBER is required for this stage.");
  });
});

describe("GitVibe action launcher targets and defaults", () => {
  it("supports discussion and pull request stages", async () => {
    const runStage = vi.fn().mockResolvedValue({
      commentBody: "",
      parsedOutput: {},
      schemaId: "validate.v1",
      status: "completed",
      summary: "Done",
      validationErrors: [],
    });

    await expect(
      runAction({
        argv: ["validate"],
        env: {
          GITHUB_REPOSITORY: "example/repo",
          GITVIBE_DISCUSSION_NUMBER: "5",
          GITVIBE_GITHUB_TOKEN: "token",
        },
        runStage,
      }),
    ).resolves.toBe(0);
    await expect(
      runAction({
        argv: ["address-pr-feedback"],
        env: {
          GITHUB_REPOSITORY: "example/repo",
          GITVIBE_GITHUB_TOKEN: "token",
          GITVIBE_PR_NUMBER: "8",
        },
        runStage,
      }),
    ).resolves.toBe(0);

    expect(runStage.mock.calls[0][0]).toMatchObject({ issueNumber: "", stage: "validate" });
    expect(runStage.mock.calls[1][0]).toMatchObject({
      prNumber: "8",
      stage: "address-pr-feedback",
    });
    expect(
      isDirectRun(new URL("../src/actions/run-action.ts", import.meta.url).href, undefined),
    ).toBe(false);
  });

  it("uses runtime defaults and skips GitHub outputs when no output file is configured", async () => {
    const appendFile = vi.fn();
    const runStage = vi.fn().mockResolvedValue({
      commentBody: "",
      parsedOutput: {},
      schemaId: "investigate.v1",
      status: "completed",
      summary: "Done",
      validationErrors: [],
    });

    await expect(
      runAction({
        appendFile,
        argv: ["validate"],
        cwd: "/fallback",
        env: {
          GITHUB_REPOSITORY: "example/repo",
          GITHUB_WORKSPACE: "/workspace",
          GITVIBE_GITHUB_TOKEN: "token",
          GITVIBE_ISSUE_NUMBER: "9",
        },
        runStage,
      }),
    ).resolves.toBe(0);

    expect(runStage).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/workspace",
        dryRun: false,
        issueNumber: "9",
        maxTurns: 90,
        stageTimeoutMinutes: 60,
      }),
    );
    expect(appendFile).not.toHaveBeenCalled();
  });
});

describe("GitVibe action launcher failure paths", () => {
  it("reports non-error stage failures and detects bundled direct execution", async () => {
    const error = vi.fn();

    await expect(
      runAction({
        argv: ["investigate"],
        env: baseEnv,
        error,
        runStage: vi.fn().mockRejectedValueOnce("plain failure"),
      }),
    ).resolves.toBe(1);

    expect(error).toHaveBeenCalledWith("plain failure");
    expect(isDirectRun("", "/tmp/run-action.cjs")).toBe(true);
  });

  it("falls back to process env and argv when runtime values are omitted", async () => {
    const originalArgv = process.argv;
    const originalEnv = process.env;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runStage = vi.fn().mockResolvedValue({
      commentBody: "",
      parsedOutput: {},
      schemaId: "investigate.v1",
      status: "completed",
      summary: "Done",
      validationErrors: [],
    });

    process.argv = ["node", "/tmp/run-action.js", "investigate"];
    process.env = { ...originalEnv, ...baseEnv };
    try {
      await expect(runAction({ log: vi.fn(), runStage })).resolves.toBe(0);
      await expect(
        runAction({
          argv: ["validate"],
          env: { GITHUB_REPOSITORY: "example/repo", GITVIBE_GITHUB_TOKEN: "token" },
        }),
      ).resolves.toBe(1);
      expect(consoleError).toHaveBeenCalledWith(
        "[git-vibe] GITVIBE_ISSUE_NUMBER or GITVIBE_DISCUSSION_NUMBER is required for validate.",
      );
    } finally {
      process.argv = originalArgv;
      process.env = originalEnv;
      consoleError.mockRestore();
    }

    expect(runStage).toHaveBeenCalledWith(expect.objectContaining({ stage: "investigate" }));
  });
});
