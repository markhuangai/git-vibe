// @ts-nocheck
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withStageHandoffs, writeStageResultFile } from "../src/runner/handoffs.ts";

describe("stage handoff helpers", () => {
  it("persists stage results and loads valid handoffs into context", () => {
    const directory = mkdtempSync(join(tmpdir(), "git-vibe-handoffs-"));
    const result = {
      commentBody: "Investigation comment",
      parsedOutput: {
        findings: ["src/app/server.ts: command workflow route owns dispatch"],
        implementation_plan: ["src/app/server.ts: remove obsolete route"],
      },
      schemaId: "investigate.v1",
      status: "completed",
      summary: "Investigated.",
      validationErrors: [],
    };

    const resultFile = writeStageResultFile({ directory, result, stage: "investigate" });
    const context = withStageHandoffs(
      {
        artifact: { body: "", number: "12", title: "Issue", type: "issue", url: "" },
        generatedAt: "2026-01-01T00:00:00Z",
        repository: "example/repo",
        timeline: [],
      },
      directory,
    );

    expect(resultFile).toBe(join(directory, "git-vibe-investigate-result.json"));
    expect(JSON.parse(readFileSync(resultFile, "utf8"))).toMatchObject({
      parsedOutput: {
        implementation_plan: ["src/app/server.ts: remove obsolete route"],
      },
      stage: "investigate",
    });
    expect(context.handoffs).toEqual([
      expect.objectContaining({
        parsedOutput: result.parsedOutput,
        stage: "investigate",
        status: "completed",
        summary: "Investigated.",
      }),
    ]);
  });
});
