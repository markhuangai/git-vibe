// @ts-nocheck
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageRunResult } from "../src/runner/stage-results.ts";
import { stageDefinitions } from "../src/shared/stages.ts";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("stageRunResult", () => {
  it("persists validated results under RUNNER_TEMP when available", async () => {
    const directory = mkdtempSync(join(tmpdir(), "git-vibe-stage-result-"));
    process.env.RUNNER_TEMP = directory;

    try {
      const result = await runValidateStageResult("/repo");

      expect(result).toMatchObject({
        schemaId: "validate.v1",
        status: "completed",
        summary: "Validated.",
      });
      expect(result.resultFile).toBe(join(directory, "git-vibe-validate-result.json"));
      expect(existsSync(result.resultFile)).toBe(true);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("persists validated results under cwd when RUNNER_TEMP is absent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "git-vibe-stage-result-"));
    delete process.env.RUNNER_TEMP;

    try {
      const result = await runValidateStageResult(directory);

      expect(result.resultFile).toBe(join(directory, "git-vibe-validate-result.json"));
      expect(existsSync(result.resultFile)).toBe(true);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

function runValidateStageResult(cwd) {
  return stageRunResult({
    content: JSON.stringify({
      assumptions: [],
      comment_body: "Ready.",
      findings: [],
      next_state: "ready-for-implementation",
      references: [],
      stage: "validate",
      status: "completed",
      summary: "Validated.",
    }),
    context: {
      artifact: {
        body: "Body",
        number: "12",
        title: "Issue",
        type: "issue",
        url: "https://github.com/example/repo/issues/12",
      },
      generatedAt: "2026-01-01T00:00:00Z",
      repository: "example/repo",
      timeline: [],
    },
    definition: stageDefinitions.validate,
    logger: { event: vi.fn() },
    options: {
      cwd,
      dryRun: false,
      issueNumber: "12",
      maxTurns: 2,
      repository: "example/repo",
      stage: "validate",
      stageTimeoutMinutes: 1,
      token: "token",
    },
  });
}
