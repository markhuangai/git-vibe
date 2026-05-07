// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.fn();
const createOpenAI = vi.fn(() => ({ chat: vi.fn(() => "openai-model") }));
const createAnthropic = vi.fn(() => ({ languageModel: vi.fn(() => "anthropic-model") }));
const execFileSync = vi.fn();

vi.mock("ai", () => ({
  generateText,
  stepCountIs: vi.fn((count) => ({ count })),
}));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic }));
vi.mock("node:child_process", () => ({ execFileSync }));

const { runAiStage } = await import("../src/runner/ai.ts");
const { stageDefinitions } = await import("../src/shared/stages.ts");

const originalEnv = { ...process.env };

beforeEach(() => {
  generateText.mockReset();
  createOpenAI.mockClear();
  createAnthropic.mockClear();
  execFileSync.mockReset();
  process.env = {
    ...originalEnv,
    GITVIBE_AI_API_KEY: "test-key",
    GITVIBE_AI_BASE_URL: "https://proxy.test/v1",
    GITVIBE_AI_MODEL: "test-model",
  };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("Claude Code CLI adapter", () => {
  it("runs configured profiles with structured output", async () => {
    process.env.CLAUDE_TOKEN = "claude-token";
    mockClaudeOutput({
      is_error: false,
      structured_output: { stage: "validate", status: "completed" },
      type: "result",
    });
    const schema = {
      additionalProperties: false,
      properties: {
        stage: { type: "string" },
        status: { type: "string" },
        questions: { items: { type: "string" }, type: "array" },
      },
      required: ["stage", "status"],
      type: "object",
    };

    await expect(runAiStage({ ...validateStageOptions(claudeCodeConfig()), schema })).resolves.toBe(
      '{"stage":"validate","status":"completed"}',
    );

    const args = execFileSync.mock.calls[0][1];
    expect(execFileSync.mock.calls[0][0]).toBe("claude");
    expect(args).toEqual(
      expect.arrayContaining([
        "-p",
        "--bare",
        "--model",
        "opus",
        "--output-format",
        "json",
        "--permission-mode",
        "dontAsk",
        "--effort",
        "xhigh",
      ]),
    );
    expect(JSON.parse(jsonSchemaFrom(args))).toEqual(
      expect.objectContaining({ required: ["stage", "status", "questions"] }),
    );
    expect(execFileSync.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        env: expect.objectContaining({ CLAUDE_CODE_OAUTH_TOKEN: "claude-token" }),
        input: "Prompt",
      }),
    );
    expect(schema.required).toEqual(["stage", "status"]);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("requires a model for profiles", async () => {
    await expect(runAiStage(validateStageOptions(missingModelConfig()))).rejects.toThrow(
      "MISSING_CLAUDE_MODEL is required for cli-claude-code profile",
    );

    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe("Claude Code CLI adapter defaults", () => {
  it("uses branch-write permissions, model env, and configured tools", async () => {
    process.env.CLAUDE_MODEL = "claude-env-model";
    mockClaudeOutput({
      is_error: false,
      structured_output: { stage: "implement", status: "completed" },
      type: "result",
    });

    await expect(runAiStage(implementStageOptions(claudeEnvModelConfig()))).resolves.toBe(
      '{"stage":"implement","status":"completed"}',
    );

    const args = execFileSync.mock.calls[0][1];
    expect(args).toEqual(expect.arrayContaining(["--model", "claude-env-model"]));
    expect(args).toEqual(expect.arrayContaining(["--permission-mode", "acceptEdits"]));
    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--effort");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Edit,Write,MultiEdit,Bash");
    expect(execFileSync.mock.calls[0][2].env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("extracts fenced and raw JSON from result text", async () => {
    mockClaudeOutput({
      is_error: false,
      result: '```json\n{"stage":"validate","status":"completed"}\n```',
      type: "result",
    });
    await expect(runAiStage(validateStageOptions(claudeCodeConfig()))).resolves.toBe(
      '{"stage":"validate","status":"completed"}',
    );

    mockClaudeOutput({
      is_error: false,
      result: '{"stage":"validate","status":"completed"}',
      type: "result",
    });
    await expect(runAiStage(validateStageOptions(claudeCodeConfig()))).resolves.toBe(
      '{"stage":"validate","status":"completed"}',
    );
  });
});

describe("Claude Code CLI adapter errors", () => {
  it("reports explicit, result-string, and unknown errors", async () => {
    mockClaudeOutput({ errors: ["bad schema"], is_error: true, type: "result" });
    await expect(runAiStage(validateStageOptions(claudeCodeConfig()))).rejects.toThrow(
      "Claude Code CLI failed: bad schema",
    );

    mockClaudeOutput({ is_error: true, result: "bad result", type: "result" });
    await expect(runAiStage(validateStageOptions(claudeCodeConfig()))).rejects.toThrow(
      "Claude Code CLI failed: bad result",
    );

    mockClaudeOutput({ is_error: true, type: "result" });
    await expect(runAiStage(validateStageOptions(claudeCodeConfig()))).rejects.toThrow(
      "Claude Code CLI failed: unknown error",
    );
  });

  it("reports non-object and non-JSON results", async () => {
    mockClaudeRawOutput("[]");
    await expect(runAiStage(validateStageOptions(claudeCodeConfig()))).rejects.toThrow(
      "Claude Code CLI returned a non-object result.",
    );

    mockClaudeOutput({ is_error: false, result: "not json", type: "result" });
    await expect(runAiStage(validateStageOptions(claudeCodeConfig()))).rejects.toThrow(
      "Claude Code CLI result did not contain a JSON object.",
    );
  });
});

function mockClaudeOutput(result) {
  execFileSync.mockImplementationOnce(() => Buffer.from(JSON.stringify(result)));
}

function mockClaudeRawOutput(result) {
  execFileSync.mockImplementationOnce(() => Buffer.from(result));
}

function jsonSchemaFrom(args) {
  return args[args.indexOf("--json-schema") + 1];
}

function validateStageOptions(config) {
  return {
    config,
    cwd: process.cwd(),
    maxTurns: 1,
    prompt: "Prompt",
    schema: {},
    schemaId: "schema",
    stage: "validate",
    stageDefinition: stageDefinitions.validate,
    system: "System",
  };
}

function implementStageOptions(config) {
  return {
    config,
    cwd: process.cwd(),
    maxTurns: 1,
    prompt: "Prompt",
    schema: {},
    schemaId: "schema",
    stage: "implement",
    stageDefinition: stageDefinitions.implement,
    system: "System",
  };
}

function claudeCodeConfig() {
  return {
    ai: {
      profiles: {
        claude_code: {
          adapter: "cli-claude-code",
          bare: true,
          command: "claude -p",
          model: "opus",
          oauth_token_secret: "CLAUDE_TOKEN",
          reasoning: {
            effort: "xhigh",
          },
        },
      },
      stages: {
        validate: {
          profile: "claude_code",
        },
      },
    },
  };
}

function claudeEnvModelConfig() {
  return {
    ai: {
      profiles: {
        claude_code: {
          adapter: "cli-claude-code",
          model_variable: "CLAUDE_MODEL",
        },
      },
      stages: {
        implement: {
          profile: "claude_code",
        },
      },
    },
  };
}

function missingModelConfig() {
  return {
    ai: {
      profiles: {
        claude_code: {
          adapter: "cli-claude-code",
          model_variable: "MISSING_CLAUDE_MODEL",
        },
      },
      stages: {
        validate: {
          profile: "claude_code",
        },
      },
    },
  };
}
