// @ts-nocheck
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  stageResultCommentHandoffs,
  withStageHandoffs,
  writeStageResultFile,
  writeStageResultSummary,
} from "../src/runner/handoffs.ts";

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
    const persisted = JSON.parse(readFileSync(resultFile, "utf8"));
    expect(persisted).toMatchObject({
      parsedOutput: {
        implementation_plan: ["src/app/server.ts: remove obsolete route"],
      },
      stage: "investigate",
    });
    expect(Number.isFinite(Date.parse(persisted.createdAt))).toBe(true);
    expect(Number.isFinite(Date.parse(persisted.updatedAt))).toBe(true);
    expect(context.handoffs).toEqual([
      expect.objectContaining({
        createdAt: persisted.createdAt,
        parsedOutput: result.parsedOutput,
        stage: "investigate",
        status: "completed",
        summary: "Investigated.",
        updatedAt: persisted.updatedAt,
      }),
    ]);
  });

  it("writes full stage details to the GitHub step summary", () => {
    const directory = mkdtempSync(join(tmpdir(), "git-vibe-summary-"));
    const summaryPath = join(directory, "summary.md");
    writeStageResultSummary({
      metadata: { profile: "reviewer", role: "security.md" },
      result: {
        commentBody: "Compact GitHub comment",
        parsedOutput: { findings: ["src/runner/stage-runner.ts: evidence"], status: "completed" },
        schemaId: "validate.v1",
        status: "completed",
        summary: "Validated.",
        validationErrors: [],
      },
      stage: "validate",
      summaryPath,
    });

    const summary = readFileSync(summaryPath, "utf8");
    expect(summary).toContain("## GitVibe validate result");
    expect(summary).toContain("- Role: `security.md`");
    expect(summary).toContain("- Profile: `reviewer`");
    expect(summary).toContain("Compact GitHub comment");
    expect(summary).toContain('"findings": [');
  });
});

describe("stage result comment handoffs", () => {
  it("promotes durable stage result comments into handoffs", () => {
    const commentBody = [
      "<!-- git-vibe:stage-result stage=investigate artifact=issue number=12 -->",
      "## GitVibe Investigation",
      "",
      "**Status:** `completed`",
      "**Next state:** `ready-for-approval`",
      "",
      "Investigation found a clear implementation path.",
      "",
      "### Details",
      "Use the existing stage runner path.",
      "",
      "### Key Findings",
      "- src/runner/stage-runner.ts builds the prompt.",
      "",
      "### Implementation Plan",
      "- src/runner/handoffs.ts should expose prior results.",
      "",
      "### References",
      "- https://github.com/example/repo/issues/12",
    ].join("\n");

    const handoffs = stageResultCommentHandoffs([
      {
        author: "git-vibe",
        body: commentBody,
        createdAt: "2026-01-01T00:00:00Z",
        id: "comment-1",
        kind: "comment",
        updatedAt: "2026-01-02T00:00:00Z",
        url: "https://github.com/example/repo/issues/12#issuecomment-1",
      },
    ]);

    expect(handoffs).toEqual([
      expect.objectContaining({
        commentBody,
        createdAt: "2026-01-01T00:00:00Z",
        schemaId: "investigate.v1",
        stage: "investigate",
        status: "completed",
        summary: "Investigation found a clear implementation path.",
        updatedAt: "2026-01-02T00:00:00Z",
      }),
    ]);
    expect(handoffs[0].parsedOutput).toMatchObject({
      comment_body: "Use the existing stage runner path.",
      findings: ["src/runner/stage-runner.ts builds the prompt."],
      implementation_plan: ["src/runner/handoffs.ts should expose prior results."],
      references: ["https://github.com/example/repo/issues/12"],
    });
  });

  it("uses safe defaults for sparse stage result comments", () => {
    const handoffs = stageResultCommentHandoffs([
      {
        author: "git-vibe",
        body: [
          "<!-- git-vibe:stage-result stage=validate artifact=issue number=12 -->",
          "## GitVibe Validation",
          "",
          "### Custom Notes",
          "- Keep this visible to downstream stages.",
        ].join("\n"),
        createdAt: "2026-01-01T00:00:00Z",
        id: "comment-1",
        kind: "comment",
        url: "https://github.com/example/repo/issues/12#issuecomment-1",
      },
    ]);

    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({
      schemaId: "validate.v1",
      stage: "validate",
      status: "completed",
      summary: "validate stage result.",
    });
    expect(handoffs[0].parsedOutput).toMatchObject({
      custom_notes: ["Keep this visible to downstream stages."],
    });
  });
});

describe("handoff defensive parsing", () => {
  it("ignores malformed handoff files and malformed stage result comments", () => {
    const directory = mkdtempSync(join(tmpdir(), "git-vibe-handoffs-"));
    writeFileSync(join(directory, "git-vibe-investigate-result.json"), "{not json");

    const context = withStageHandoffs(
      {
        artifact: { body: "", number: "12", title: "Issue", type: "issue", url: "" },
        generatedAt: "2026-01-01T00:00:00Z",
        repository: "example/repo",
        timeline: [
          {
            author: "git-vibe",
            body: "<!-- git-vibe:stage-result stage=missing artifact=issue number=12 -->",
            createdAt: "2026-01-01T00:00:00Z",
            id: "comment-1",
            kind: "comment",
            url: "https://github.com/example/repo/issues/12#issuecomment-1",
          },
        ],
      },
      directory,
    );

    expect(context.handoffs).toBeUndefined();
    expect(stageResultCommentHandoffs([])).toEqual([]);
  });

  it("deduplicates repeated stage result comments with the same content", () => {
    const comment = {
      author: "git-vibe",
      body: [
        "<!-- git-vibe:stage-result stage=investigate artifact=issue number=12 -->",
        "## GitVibe Investigation",
        "",
        "**Status:** `completed`",
        "",
        "Same summary.",
        "",
        "### Details",
        "Same result",
      ].join("\n"),
      createdAt: "2026-01-01T00:00:00Z",
      id: "comment-1",
      kind: "comment",
      url: "https://github.com/example/repo/issues/12#issuecomment-1",
    };
    const context = withStageHandoffs({
      artifact: { body: "", number: "12", title: "Issue", type: "issue", url: "" },
      generatedAt: "2026-01-01T00:00:00Z",
      repository: "example/repo",
      timeline: [comment, { ...comment, id: "comment-2" }],
    });

    expect(context.handoffs).toHaveLength(1);
  });

  it("treats missing handoff directories as no handoffs", () => {
    const context = withStageHandoffs(
      {
        artifact: { body: "", number: "12", title: "Issue", type: "issue", url: "" },
        generatedAt: "2026-01-01T00:00:00Z",
        repository: "example/repo",
        timeline: [],
      },
      join(tmpdir(), "git-vibe-missing-handoffs"),
    );

    expect(context.handoffs).toBeUndefined();
  });
});
