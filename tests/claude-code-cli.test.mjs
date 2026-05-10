// @ts-nocheck
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.fn();
const createOpenAI = vi.fn(() => ({ chat: vi.fn(() => "openai-model") }));
const createAnthropic = vi.fn(() => ({ languageModel: vi.fn(() => "anthropic-model") }));
const spawn = vi.fn();
const spawnedChildren = [];

vi.mock("ai", () => ({
  generateText,
  stepCountIs: vi.fn((count) => ({ count })),
}));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic }));
vi.mock("node:child_process", () => ({ spawn }));

const { runAiStage } = await import("../src/runner/ai.ts");
const { stageDefinitions } = await import("../src/shared/stages.ts");

const originalEnv = { ...process.env };

beforeEach(() => {
  generateText.mockReset();
  createOpenAI.mockClear();
  createAnthropic.mockClear();
  spawn.mockReset();
  spawnedChildren.length = 0;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  process.env = {
    ...originalEnv,
    GITVIBE_AI_ENV_JSON: JSON.stringify({
      CLAUDE_TOKEN: "claude-token",
      GITVIBE_AI_API_KEY: "test-key",
      GITVIBE_AI_BASE_URL: "https://proxy.test/v1",
      MINIMAX_API_KEY: "minimax-key",
      MINIMAX_BASE_URL: "https://minimax.test/anthropic",
    }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("Claude Code CLI adapter", () => {
  it("runs configured profiles with structured output", async () => {
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

    const args = spawn.mock.calls[0][1];
    expect(spawn.mock.calls[0][0]).toBe("claude");
    expect(args).toEqual(
      expect.arrayContaining([
        "-p",
        "--bare",
        "--dangerously-skip-permissions",
        "--model",
        "opus",
        "--output-format",
        "json",
        "--effort",
        "xhigh",
      ]),
    );
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("--tools");
    expect(JSON.parse(jsonSchemaFrom(args))).toEqual(
      expect.objectContaining({ required: ["stage", "status", "questions"] }),
    );
    expect(spawn.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        cwd: process.cwd(),
        env: expect.objectContaining({
          ANTHROPIC_API_KEY: "minimax-key",
          ANTHROPIC_BASE_URL: "https://minimax.test/anthropic",
          CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
        }),
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(spawn.mock.calls[0][2].env.GITVIBE_AI_ENV_JSON).toBeUndefined();
    expect(spawnedChildren[0].stdin.end).toHaveBeenCalledWith("Prompt");
    expect(process.stdout.write).toHaveBeenCalledWith(
      Buffer.from(
        JSON.stringify({
          is_error: false,
          structured_output: { stage: "validate", status: "completed" },
          type: "result",
        }),
      ),
    );
    expect(schema.required).toEqual(["stage", "status"]);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("requires a model for profiles", async () => {
    await expect(runAiStage(validateStageOptions(missingModelConfig()))).rejects.toThrow(
      "AI profile model must be configured for cli-claude-code profile.",
    );

    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("Claude Code CLI adapter defaults", () => {
  it("uses configured model without permission mode or tool restrictions", async () => {
    mockClaudeOutput({
      is_error: false,
      structured_output: { stage: "implement", status: "completed" },
      type: "result",
    });

    await expect(runAiStage(implementStageOptions(claudeEnvModelConfig()))).resolves.toBe(
      '{"stage":"implement","status":"completed"}',
    );

    const args = spawn.mock.calls[0][1];
    expect(args).toEqual(expect.arrayContaining(["--model", "claude-test-model"]));
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("--tools");
    expect(spawn.mock.calls[0][2].env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
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

  it("streams stderr while preserving structured stdout", async () => {
    const output = JSON.stringify({
      is_error: false,
      structured_output: { stage: "validate", status: "completed" },
      type: "result",
    });
    mockClaudeRawOutput(output, { stderr: "claude warning\n", stdoutAsString: true });

    await expect(runAiStage(validateStageOptions(claudeCodeConfig()))).resolves.toBe(
      '{"stage":"validate","status":"completed"}',
    );

    expect(process.stdout.write).toHaveBeenCalledWith(Buffer.from(output));
    expect(process.stderr.write).toHaveBeenCalledWith(Buffer.from("claude warning\n"));
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

  it("reports failed CLI exits with stderr and signals", async () => {
    mockClaudeRawOutput("", { exitCode: 2, stderr: "bad flags\n" });
    await expect(runAiStage(validateStageOptions(claudeCodeConfig()))).rejects.toThrow(
      "claude failed with exit code 2: bad flags",
    );

    mockClaudeRawOutput("", { exitCode: null, signal: "SIGTERM" });
    await expect(runAiStage(validateStageOptions(claudeCodeConfig()))).rejects.toThrow(
      "claude failed with signal SIGTERM",
    );
  });
});

function mockClaudeOutput(result) {
  mockClaudeRawOutput(JSON.stringify(result));
}

function mockClaudeRawOutput(result, options = {}) {
  spawn.mockImplementationOnce(() => mockChildProcess({ ...options, stdout: result }));
}

function mockChildProcess({
  exitCode = 0,
  signal = null,
  stderr = "",
  stdout = "",
  stdoutAsString = false,
}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    end: vi.fn(() => {
      setImmediate(() => {
        if (stdout) child.stdout.emit("data", stdoutAsString ? stdout : Buffer.from(stdout));
        if (stderr) child.stderr.emit("data", Buffer.from(stderr));
        child.emit("close", exitCode, signal);
      });
    }),
  };
  spawnedChildren.push(child);
  return child;
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
          env: {
            ANTHROPIC_API_KEY: { from_bundle: "MINIMAX_API_KEY" },
            ANTHROPIC_BASE_URL: { from_bundle: "MINIMAX_BASE_URL" },
            CLAUDE_CODE_OAUTH_TOKEN: { from_bundle: "CLAUDE_TOKEN" },
          },
          model: "opus",
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
          model: "claude-test-model",
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
