// @ts-nocheck
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runStageResultForMode } from "../src/runner/stage-ai-results.ts";
import { loadStageSchema } from "../src/runner/schemas.ts";
import { stageDefinitions } from "../src/shared/stages.ts";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = {
    ...originalEnv,
    RUNNER_TEMP: mkdtempSync(join(tmpdir(), "git-vibe-runner-")),
  };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("matrix finalizer safety sources", () => {
  it("safety-scans member outputs without scanning trusted role definitions", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "git-vibe-finalizer-safety-"));
    const resultsDir = join(cwd, "member-results");
    const roleDefinition = [
      "Review the change for markhuang.ai behavioral correctness.",
      "Respect the repository's verification scope.",
      "Return only the current stage schema.",
    ].join("\n");
    writeRole(cwd, "security.md", roleDefinition);
    mkdirSync(resultsDir);
    writeFileSync(join(resultsDir, "git-vibe-validate-result.json"), memberResult());
    const config = roleGroupConfig();
    const definition = stageDefinitions.validate;
    globalThis.__gitVibeSdkMocks.queueCodexOutput(allowedSafetyOutput());
    globalThis.__gitVibeSdkMocks.queueCodexOutput(synthesizedOutput());

    const result = await runStageResultForMode({
      acceptedRisk: false,
      aiRunOptions: {
        config,
        cwd,
        maxTurns: 2,
        prompt: "base prompt",
        schema: loadStageSchema(definition.schemaFile),
        schemaId: definition.schemaId,
        stage: "validate",
        stageDefinition: definition,
        system: "system prompt",
      },
      config,
      context: contextPacket(),
      definition,
      executionMode: "finalizer",
      logger: { event: vi.fn() },
      options: runnerOptions(cwd, resultsDir),
    });

    expect(result.summary).toBe("Synthesized.");
    const calls = globalThis.__gitVibeSdkMocks.codexRun.mock.calls.map(([input, turnOptions]) => ({
      input: String(input),
      schemaId: turnOptions.outputSchema?.$id,
    }));
    expect(calls.map((call) => call.schemaId)).toEqual(["safety-gate.v1", "validate.v1"]);

    const safetyPrompt = safetyPromptJson(calls[0].input);
    expect(safetyPrompt.sources.map((source) => source.label)).toContain("matrix member result 1");
    expect(safetyPrompt.sources.map((source) => source.label).join("\n")).not.toContain(
      "role-group security.md definition",
    );
    expect(JSON.stringify(safetyPrompt)).not.toContain(roleDefinition);

    expect(calls[1].input).toContain('"role_definition"');
    expect(calls[1].input).toContain("Review the change for markhuang.ai");
  });
});

function roleGroupConfig() {
  return {
    ai: {
      profiles: {
        test: {
          adapter: "codex-sdk",
          model: "test-model",
        },
      },
      role_groups: {
        review_gate: {
          roles: [{ profile: "test", role: "security.md" }],
          synthesizer: "test",
        },
      },
      stages: {
        validate: {
          role_group: "review_gate",
        },
      },
    },
    safety: {
      prompt_injection_gate: true,
    },
  };
}

function runnerOptions(cwd, resultsDir) {
  return {
    cwd,
    dryRun: false,
    executionMode: "finalizer",
    issueNumber: "12",
    maxTurns: 2,
    memberResultsDir: resultsDir,
    prNumber: "",
    repository: "example/repo",
    stage: "validate",
    stageTimeoutMinutes: 1,
    token: "token",
  };
}

function contextPacket() {
  return {
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
  };
}

function writeRole(cwd, file, content) {
  mkdirSync(join(cwd, ".git-vibe", "role-group"), { recursive: true });
  writeFileSync(join(cwd, ".git-vibe", "role-group", file), content);
}

function memberResult() {
  return JSON.stringify({
    parsedOutput: {
      assumptions: [],
      comment_body: "Role reviewed.",
      findings: [],
      next_state: "ready-for-implementation",
      references: [],
      stage: "validate",
      status: "completed",
      summary: "Role reviewed.",
    },
    profile: "test",
    role: "security.md",
    schemaId: "validate.v1",
    stage: "validate",
    status: "completed",
    summary: "Role reviewed.",
  });
}

function allowedSafetyOutput() {
  return {
    findings: [],
    severity: "none",
    status: "allowed",
    summary: "No prompt-injection risk detected.",
  };
}

function synthesizedOutput() {
  return {
    assumptions: [],
    comment_body: "Synthesized.",
    findings: [],
    next_state: "ready-for-implementation",
    references: [],
    stage: "validate",
    status: "completed",
    summary: "Synthesized.",
  };
}

function safetyPromptJson(input) {
  return JSON.parse(input.slice(input.indexOf("{")));
}
