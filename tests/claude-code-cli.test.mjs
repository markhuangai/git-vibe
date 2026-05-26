// @ts-nocheck
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.fn();
const createOpenAI = vi.fn(() => ({ chat: vi.fn(() => "openai-model") }));
const createAnthropic = vi.fn(() => ({ languageModel: vi.fn(() => "anthropic-model") }));
const spawn = vi.fn();
const spawnedChildren = [];

vi.mock("ai", () => ({
  generateText,
  hasToolCall: vi.fn((toolName) => ({ toolName })),
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
    const result = {
      duration_ms: 12,
      is_error: false,
      num_turns: 2,
      stop_reason: "end_turn",
      subtype: "success",
      structured_output: { stage: "validate", status: "completed" },
      terminal_reason: "completed",
      type: "result",
    };
    mockReadableClaudeStream(result);
    const schema = structuredQuestionSchema();

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
        "stream-json",
        "--verbose",
        "--effort",
        "xhigh",
      ]),
    );
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("--tools");
    expect(args).not.toContain("--disallowedTools");
    expect(args[args.indexOf("--system-prompt") + 1]).toContain("GitVibe web access policy");
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
      expect.stringContaining("ai.claude.init model=opus"),
    );
    expect(process.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining('ai.claude.prompt kind=system preview="System'),
    );
    expect(process.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining('ai.claude.prompt kind=user preview="Prompt" chars=6'),
    );
    expect(process.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining("ai.claude.message text=Reading files"),
    );
    expect(process.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining("ai.claude.tool input=file_path=src/index.ts tool=Read"),
    );
    expect(process.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining("ai.claude.tool_result chars=6"),
    );
    expect(process.stdout.write).not.toHaveBeenCalledWith(expect.stringContaining("text=1 code"));
    expect(process.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining("ai.claude.result duration_ms=12 reason=completed"),
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

describe("Claude Code CLI profile context", () => {
  it("adds context files configured on Claude Code profiles to the system prompt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "git-vibe-claude-context-"));
    writeFileSync(join(cwd, "CLAUDE-extra.md"), "Claude profile guidance.");
    const config = claudeCodeConfig();
    config.ai.profiles.claude_code.context = { files: ["CLAUDE-extra.md"] };
    mockReadableClaudeStream({
      is_error: false,
      structured_output: { stage: "validate", status: "completed" },
      type: "result",
    });

    try {
      await expect(
        runAiStage({
          ...validateStageOptions(config),
          cwd,
        }),
      ).resolves.toBe('{"stage":"validate","status":"completed"}');

      const args = spawn.mock.calls[0][1];
      const systemPrompt = args[args.indexOf("--system-prompt") + 1];
      expect(systemPrompt).toContain(
        '<git_vibe_profile_context profile="claude_code" path="CLAUDE-extra.md">',
      );
      expect(systemPrompt).toContain("Claude profile guidance.");
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
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
    expect(args).not.toContain("--disallowedTools");
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

    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining("ai.claude.result"));
    expect(process.stdout.write).not.toHaveBeenCalledWith(output);
    expect(process.stderr.write).toHaveBeenCalledWith("claude warning\n");
  });

  it("renders diagnostic stream events through the stage logger", async () => {
    const logger = { event: vi.fn() };
    mockDiagnosticClaudeStream({
      is_error: false,
      structured_output: { stage: "validate", status: "completed" },
      subtype: "success",
      type: "result",
    });

    await expect(runAiStage({ ...validateStageOptions(claudeCodeConfig()), logger })).resolves.toBe(
      '{"stage":"validate","status":"completed"}',
    );

    expect(logger.event).toHaveBeenCalledWith(
      "ai.claude.retry",
      expect.objectContaining({ attempt: 1, status: 503 }),
    );
    expect(logger.event).toHaveBeenCalledWith("ai.claude.thinking", { chars: 8 });
    expect(logger.event).toHaveBeenCalledWith(
      "ai.claude.tool",
      expect.objectContaining({ input: "command=pnpm test", tool: "Bash" }),
    );
    expect(logger.event).toHaveBeenCalledWith(
      "ai.claude.tool",
      expect.objectContaining({ input: "keys=stage,status", tool: "StructuredOutput" }),
    );
    expect(logger.event).toHaveBeenCalledWith("ai.claude.assistant", { items: 1 });
    expect(logger.event).toHaveBeenCalledWith(
      "ai.claude.system",
      expect.objectContaining({ subtype: "custom" }),
    );
    expect(logger.event).toHaveBeenCalledWith(
      "ai.claude.event",
      expect.objectContaining({ type: "custom" }),
    );
    expect(process.stdout.write).not.toHaveBeenCalled();
  });
});

describe("Claude Code CLI prompt logging", () => {
  it("caps prompt previews at 300 compact characters and logs full counts", async () => {
    mockClaudeOutput({
      is_error: false,
      structured_output: { stage: "validate", status: "completed" },
      type: "result",
    });
    const longPrompt = `${"a".repeat(160)}\n${"b".repeat(160)}`;

    await expect(
      runAiStage({
        ...validateStageOptions(claudeCodeConfig()),
        prompt: longPrompt,
        system: "System",
      }),
    ).resolves.toBe('{"stage":"validate","status":"completed"}');

    const output = process.stdout.write.mock.calls.map((call) => call[0]).join("");
    expect(output).toContain(`kind=user preview="${`${"a".repeat(160)} ${"b".repeat(136)}...`}"`);
    expect(output).toContain("chars=321");
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

    mockClaudeOutput({ is_error: false, subtype: "error_max_structured_output_retries" });
    await expect(runAiStage(validateStageOptions(claudeCodeConfig()))).rejects.toThrow(
      "Claude Code CLI failed: error_max_structured_output_retries",
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

    mockClaudeStreamOutput({ subtype: "init", type: "system" });
    await expect(runAiStage(validateStageOptions(claudeCodeConfig()))).rejects.toThrow(
      "Claude Code CLI stream did not contain a result event.",
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

function mockClaudeStreamOutput(...events) {
  mockClaudeRawOutput(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

function mockReadableClaudeStream(result) {
  mockClaudeStreamOutput(
    {
      claude_code_version: "2.1.138",
      model: "opus",
      permissionMode: "bypassPermissions",
      subtype: "init",
      tools: ["Read", "StructuredOutput"],
      type: "system",
    },
    {
      message: {
        content: [
          { text: "Reading files", type: "text" },
          { input: { file_path: "src/index.ts" }, name: "Read", type: "tool_use" },
        ],
      },
      type: "assistant",
    },
    {
      message: {
        content: [{ content: "1\tcode", type: "tool_result" }],
      },
      type: "user",
    },
    result,
  );
}

function mockDiagnosticClaudeStream(result) {
  mockClaudeStreamOutput(
    {
      attempt: 1,
      error: "server_error",
      error_status: 503,
      retry_delay_ms: 12.5,
      subtype: "api_retry",
      type: "system",
    },
    {
      message: {
        content: [
          { thinking: "thinking", type: "thinking" },
          { input: { command: "pnpm test" }, name: "Bash", type: "tool_use" },
          {
            input: { stage: "validate", status: "completed" },
            name: "StructuredOutput",
            type: "tool_use",
          },
          { input: {}, name: "Noop", type: "tool_use" },
        ],
      },
      type: "assistant",
    },
    {
      message: {
        content: [{ source: "unknown", type: "image" }],
      },
      type: "assistant",
    },
    { subtype: "custom", type: "system" },
    { type: "custom" },
    result,
  );
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

function structuredQuestionSchema() {
  return {
    additionalProperties: false,
    properties: {
      stage: { type: "string" },
      status: { type: "string" },
      questions: {
        items: {
          additionalProperties: false,
          properties: {
            options: { items: { type: "string" }, maxItems: 4, minItems: 1, type: "array" },
            question: { type: "string" },
          },
          required: ["question", "options"],
          type: "object",
        },
        type: "array",
      },
    },
    required: ["stage", "status"],
    type: "object",
  };
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
