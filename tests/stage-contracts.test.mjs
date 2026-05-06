import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractValidatedOutput } from "../src/lib/ai.ts";
import { renderPrompts } from "../src/lib/prompts.ts";
import { loadStageSchema, validateOutput } from "../src/lib/schemas.ts";
import { parseStage, stageDefinitions } from "../src/lib/stages.ts";

/** @type {import("../src/lib/types.ts").ContextPacket} */
const baseContext = {
  artifact: {
    body: "Body",
    number: "123",
    title: "Title",
    type: "issue",
    url: "https://github.com/example/repo/issues/123",
  },
  generatedAt: "2026-05-05T00:00:00.000Z",
  repository: "example/repo",
  timeline: [],
};

describe("stage contracts", () => {
  it("defines every public action stage", () => {
    expect(Object.keys(stageDefinitions).sort()).toEqual([
      "address-pr-feedback",
      "create-pr",
      "implement",
      "investigate",
      "materialize",
      "review-matrix",
      "summarize",
      "validate",
    ]);
    expect(parseStage("summarize")).toBe("summarize");
    expect(() => parseStage("unknown")).toThrow("Unknown GitVibe action stage");
  });

  it("renders prompt templates with XML sections", () => {
    const schema = loadStageSchema(stageDefinitions.investigate.schemaFile);
    const prompts = renderPrompts({
      context: baseContext,
      outputSchema: schema,
      promptDir: stageDefinitions.investigate.promptDir,
      repositoryContext: "## main",
      stageContract: "Return JSON.",
    });

    expect(prompts.system).toMatch(/bug investigation/i);
    expect(prompts.system).toContain("GitVibe Stage Agent Contract");
    expect(prompts.system).toContain("output_validator");
    expect(prompts.prompt).toContain("<context_package>");
    expect(prompts.prompt).toContain("<github_context>");
    expect(prompts.prompt).toContain("<repository_context>");
    expect(prompts.prompt).toContain("<stage_contract>");
    expect(prompts.prompt).toContain("<output_schema>");
    expect(prompts.prompt).toContain("<required_process>");
    expect(prompts.prompt).toContain("<stage_goal>");
    expect(prompts.prompt).toContain("<investigation_focus>");
  });

  it("loads assets relative to GITHUB_ACTION_PATH when provided", () => {
    const original = process.env.GITHUB_ACTION_PATH;
    delete process.env.GITVIBE_ASSET_ROOT;
    process.env.GITHUB_ACTION_PATH = `${process.cwd()}/investigate`;
    try {
      expect(loadStageSchema(stageDefinitions.investigate.schemaFile)).toMatchObject({
        $id: "bug-investigation.v1",
      });
    } finally {
      if (original === undefined) delete process.env.GITHUB_ACTION_PATH;
      else process.env.GITHUB_ACTION_PATH = original;
    }
  });

  it("documents deterministic implementation branches in stage prompts", () => {
    const schema = loadStageSchema(stageDefinitions.implement.schemaFile);
    const prompts = renderPrompts({
      context: baseContext,
      outputSchema: schema,
      promptDir: stageDefinitions.implement.promptDir,
      repositoryContext: "## main",
      stageContract:
        "Stage implement has branch-write access. GitVibe owns branch selection; use git-vibe/123 exactly and do not invent a branch name.",
    });

    expect(prompts.prompt).toContain("git-vibe/123");
    expect(prompts.prompt).toContain("do not invent a branch name");
  });

  it("keeps every stage prompt substantive and XML structured", () => {
    const promptDirs = new Set(Object.values(stageDefinitions).map((stage) => stage.promptDir));

    for (const promptDir of promptDirs) {
      const system = readFileSync(join("prompts", promptDir, "system.md"), "utf8");
      const user = readFileSync(join("prompts", promptDir, "user.md"), "utf8");

      expect(system.length, `${promptDir} system prompt should be substantive`).toBeGreaterThan(
        500,
      );
      expect(system, `${promptDir} system prompt should define a role`).toContain("## Role");
      expect(system, `${promptDir} system prompt should define a scope`).toContain("## Scope");
      expect(user, `${promptDir} user prompt should define a stage goal`).toContain("<stage_goal>");
      expect(user, `${promptDir} user prompt should guide schema fields`).toContain(
        "<required_fields_guidance>",
      );
      expect(user, `${promptDir} user prompt should use XML closing tags`).toContain(
        "</required_fields_guidance>",
      );
    }
  });
});

describe("stage output validation", () => {
  it("validates stage output with agentool output-validator", async () => {
    const schema = loadStageSchema(stageDefinitions["create-pr"].schemaFile);
    const output = {
      assumptions: [],
      branch: "git-vibe/123",
      comment_body: "Ready for review.",
      findings: [],
      next_state: "git-vibe:pr-opened",
      pr_body: "Refs #123",
      pr_title: "GitVibe: Title",
      references: ["https://github.com/example/repo/issues/123"],
      stage: "create-pr",
      status: "completed",
      summary: "PR draft is ready.",
    };

    await expect(
      validateOutput({
        content: JSON.stringify(output),
        schema,
        schemaId: stageDefinitions["create-pr"].schemaId,
      }),
    ).resolves.toMatchObject({ stage: "create-pr" });
  });

  it("rejects malformed and schema-invalid stage output", async () => {
    const schema = loadStageSchema(stageDefinitions["create-pr"].schemaFile);

    await expect(
      validateOutput({
        content: "not json",
        schema,
        schemaId: stageDefinitions["create-pr"].schemaId,
      }),
    ).rejects.toThrow();
    await expect(
      validateOutput({
        content: JSON.stringify({ stage: "create-pr", status: "completed" }),
        schema,
        schemaId: stageDefinitions["create-pr"].schemaId,
      }),
    ).rejects.toThrow("AI output failed create-pr.v1 validation");
  });

  it("prefers the JSON passed to output_validator when extracting AI stage output", () => {
    const content = JSON.stringify({ stage: "create-pr", status: "completed" });

    expect(
      extractValidatedOutput({
        steps: [{ toolCalls: [{ input: { content }, toolName: "output_validator" }] }],
        text: '{"stage":"wrong"}',
      }),
    ).toBe(content);
    expect(
      extractValidatedOutput({
        steps: [{ toolCalls: [{ input: {}, toolName: "output_validator" }] }],
        text: `\`\`\`json\n${content}\n\`\`\``,
      }),
    ).toBe(content);
    expect(extractValidatedOutput({ steps: [], text: content })).toBe(content);
    expect(
      extractValidatedOutput({
        steps: [{ toolCalls: [{ input: { content: "{}" }, toolName: "read" }] }, {}],
        text: content,
      }),
    ).toBe(content);
    expect(extractValidatedOutput({ text: content })).toBe(content);
  });
});

describe("bundled action runtime", () => {
  it("builds the launcher from source with a Node-compatible shebang", () => {
    const build = spawnSync(process.execPath, ["scripts/build-actions.mjs"], {
      encoding: "utf8",
    });
    expect(build.status, build.stderr || build.stdout).toBe(0);

    const bundle = readFileSync("dist/actions/run-action.js", "utf8");
    const result = spawnSync(process.execPath, ["dist/actions/run-action.js", "investigate"], {
      encoding: "utf8",
    });

    expect(bundle.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(
      bundle
        .split("\n")
        .slice(1)
        .some((line) => line.startsWith("#!")),
    ).toBe(false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GITVIBE_GITHUB_TOKEN is required.");
  }, 15000);
});
