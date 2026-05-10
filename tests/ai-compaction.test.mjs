// @ts-nocheck
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { setImmediate } from "node:timers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const compactMessages = vi.fn();
const generateText = vi.fn();
const createOpenAI = vi.fn(() => ({ chat: vi.fn(() => "openai-model") }));
const createAnthropic = vi.fn(() => ({ languageModel: vi.fn(() => "anthropic-model") }));
const spawn = vi.fn();

vi.mock("agentool/context-compaction", () => ({ compactMessages }));
vi.mock("ai", () => ({
  generateText,
  stepCountIs: vi.fn((count) => ({ count })),
}));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic }));
vi.mock("node:child_process", () => ({ spawn }));

const { runAiStage } = await import("../src/runner/ai.ts");
const {
  compactStepMessages,
  contextWindowTokensForProfile,
  estimateModelMessagesTokens,
  maxContextWindowTokensFor,
} = await import("../src/runner/ai-compaction.ts");
const { stageDefinitions } = await import("../src/shared/stages.ts");

const originalEnv = { ...process.env };

beforeEach(() => {
  compactMessages.mockReset();
  generateText.mockReset();
  createOpenAI.mockClear();
  createAnthropic.mockClear();
  spawn.mockReset();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  process.env = {
    ...originalEnv,
    GITVIBE_AI_ENV_JSON: JSON.stringify({
      CODEX_AUTH_JSON: '{"tokens":[]}',
      GITVIBE_AI_API_KEY: "test-key",
      GITVIBE_AI_BASE_URL: "https://proxy.test/v1",
    }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("AI context compaction config", () => {
  it("defaults max context window tokens and validates overrides", () => {
    expect(maxContextWindowTokensFor({})).toBe(200000);
    expect(
      maxContextWindowTokensFor({ ai: { budgets: { max_context_window_tokens: 1234 } } }),
    ).toBe(1234);
    expect(maxContextWindowTokensFor({ ai: { budgets: null } })).toBe(200000);
    expect(() =>
      maxContextWindowTokensFor({ ai: { budgets: { max_context_window_tokens: 0 } } }),
    ).toThrow("ai.budgets.max_context_window_tokens must be a positive integer.");
  });

  it("allows profile context window overrides and rejects malformed profile values", () => {
    expect(contextWindowTokensForProfile("local_proxy", { context_window_tokens: 99 }, {})).toBe(
      99,
    );
    expect(() =>
      contextWindowTokensForProfile("local_proxy", { context_window_tokens: 0 }, {}),
    ).toThrow("AI profile local_proxy context_window_tokens must be a positive integer.");
  });
});

describe("AI context compaction prepare step", () => {
  it("does not call compaction below the 90 percent threshold", async () => {
    await expect(compactAtStep([textMessage("short")], { maxTokens: 100 })).resolves.toEqual({});

    expect(compactMessages).not.toHaveBeenCalled();
  });

  it("compacts and logs when estimated context reaches the 90 percent threshold", async () => {
    const logger = { event: vi.fn() };
    const compacted = [textMessage("summary")];
    compactMessages.mockResolvedValueOnce(compacted);

    await expect(
      compactAtStep([textMessage("x".repeat(32))], { logger, maxTokens: 10 }),
    ).resolves.toEqual({ messages: compacted });

    expect(compactMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        autoCompactThresholdPct: 0.8,
        maxContextTokens: 10,
        reservedOutputTokens: 0,
      }),
    );
    expect(logger.event).toHaveBeenCalledWith(
      "ai.context.compact",
      expect.objectContaining({
        before_tokens: 9,
        changed: true,
        max_context_window_tokens: 10,
        profile: "local_proxy",
        reason: "threshold",
        step: 1,
        threshold_pct: 90,
      }),
    );
  });

  it("logs a no-op when compaction is triggered but agentool keeps the original messages", async () => {
    const logger = { event: vi.fn() };
    compactMessages.mockImplementationOnce(async ({ messages }) => messages);

    await expect(
      compactAtStep([textMessage("x".repeat(32))], { logger, maxTokens: 10 }),
    ).resolves.toEqual({});

    expect(logger.event).toHaveBeenCalledWith(
      "ai.context.compact",
      expect.objectContaining({ changed: false, reason: "threshold" }),
    );
  });

  it("uses the pre-add reason when messages would exceed the max context window", async () => {
    const logger = { event: vi.fn() };
    compactMessages.mockImplementationOnce(async ({ messages }) => {
      expect(messages).toEqual([textMessage("x".repeat(24))]);
      return [textMessage("summary")];
    });

    await compactAtStep([textMessage("x".repeat(24)), textMessage("incoming")], {
      logger,
      maxTokens: 10,
    });

    expect(compactMessages).toHaveBeenCalledWith(
      expect.objectContaining({ autoCompactThresholdPct: 0.6 }),
    );
    expect(logger.event).toHaveBeenCalledWith(
      "ai.context.compact",
      expect.objectContaining({ reason: "pre_add" }),
    );
  });

  it("forces pre-add compaction when the existing history already exceeds the max window", async () => {
    compactMessages.mockResolvedValueOnce([textMessage("summary")]);

    await compactAtStep([textMessage("x".repeat(80)), textMessage("incoming")], {
      maxTokens: 10,
    });

    expect(compactMessages).toHaveBeenCalledWith(
      expect.objectContaining({ autoCompactThresholdPct: 1 }),
    );
  });

  it("logs and rethrows compaction failures", async () => {
    const logger = { event: vi.fn() };
    compactMessages.mockRejectedValueOnce(new Error("summary failed"));

    await expect(
      compactAtStep([textMessage("x".repeat(32))], { logger, maxTokens: 10 }),
    ).rejects.toThrow("summary failed");

    expect(logger.event).toHaveBeenCalledWith(
      "ai.context.compact.failed",
      expect.objectContaining({ before_tokens: 9, reason: "threshold" }),
    );
  });
});

describe("AI context compaction message handling", () => {
  it("does not include system messages in compaction input", async () => {
    compactMessages.mockImplementationOnce(async ({ messages }) => {
      expect(messages.some((message) => message.role === "system")).toBe(false);
      return [textMessage("summary")];
    });

    await compactAtStep(
      [{ role: "system", content: "Do not compact this." }, textMessage("x".repeat(36))],
      { maxTokens: 10 },
    );
  });

  it("estimates mixed model message content without throwing on unserializable values", () => {
    const circular = {};
    circular.self = circular;

    expect(
      estimateModelMessagesTokens([
        {
          role: "assistant",
          content: [
            { text: "abcd", type: "text" },
            { text: "efgh", type: "reasoning" },
            { type: "image" },
            { type: "file" },
            { input: { command: "pnpm check" }, toolName: "bash", type: "tool-call" },
            {
              output: { type: "text", value: "ok" },
              toolName: "bash",
              type: "tool-result",
            },
            { type: "other", value: circular },
            null,
          ],
        },
        { content: { nested: true } },
        { role: "user", content: undefined },
      ]),
    ).toBeGreaterThan(300);
  });
});

describe("AI context compaction stage wiring", () => {
  it("wires compaction through ai-sdk-agentool prepareStep and keeps system separate", async () => {
    const logger = { event: vi.fn() };
    const compacted = [textMessage("summary")];
    compactMessages.mockResolvedValueOnce(compacted);
    generateText.mockImplementationOnce(async (request) => {
      expect(request.system).toBe("System");
      expect(request.prompt).toBe("Prompt");
      const prepared = await request.prepareStep({
        messages: [textMessage("x".repeat(32))],
        stepNumber: 0,
      });
      expect(prepared).toEqual({ messages: compacted });
      request.onStepFinish({ finishReason: "stop", toolCalls: [] });
      return { steps: [], text: '{"stage":"investigate","status":"completed"}' };
    });

    await expect(runAiStage(aiSdkOptions({ logger }))).resolves.toBe(
      '{"stage":"investigate","status":"completed"}',
    );

    expect(logger.event).toHaveBeenCalledWith(
      "ai.context.compact",
      expect.objectContaining({ profile: "local_proxy", reason: "threshold" }),
    );
  });

  it("does not invoke compaction for Codex CLI profiles", async () => {
    mockCodexOutput('{"stage":"validate","status":"completed"}');

    await expect(runAiStage(codexOptions())).resolves.toBe(
      '{"stage":"validate","status":"completed"}',
    );

    expect(generateText).not.toHaveBeenCalled();
    expect(compactMessages).not.toHaveBeenCalled();
  });
});

async function compactAtStep(messages, { logger = { event: vi.fn() }, maxTokens }) {
  return compactStepMessages({
    config: { ai: { budgets: { max_context_window_tokens: maxTokens } } },
    logger,
    messages,
    model: "openai-model",
    profile: {},
    profileName: "local_proxy",
    stepNumber: 0,
  });
}

function textMessage(content) {
  return { role: "user", content };
}

function aiSdkOptions({ logger }) {
  return {
    config: {
      ai: {
        budgets: { max_context_window_tokens: 10 },
        profiles: {
          local_proxy: {
            provider: {
              api_key: { from_bundle: "GITVIBE_AI_API_KEY" },
              base_url: { from_bundle: "GITVIBE_AI_BASE_URL" },
              model: "glm-5",
              type: "openai-compatible",
            },
          },
        },
        stages: {
          investigate: {
            profile: "local_proxy",
          },
        },
      },
    },
    cwd: process.cwd(),
    logger,
    maxTurns: 1,
    prompt: "Prompt",
    schema: {},
    schemaId: "schema",
    stage: "investigate",
    stageDefinition: stageDefinitions.investigate,
    system: "System",
  };
}

function codexOptions() {
  return {
    config: {
      ai: {
        profiles: {
          codex_cli: {
            adapter: "cli-codex",
            auth_json: { from_bundle: "CODEX_AUTH_JSON" },
            model: "gpt-5.5",
          },
        },
        stages: { validate: { profile: "codex_cli" } },
      },
    },
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

function mockCodexOutput(content) {
  spawn.mockImplementationOnce((_command, args) =>
    mockChildProcess({ onInput: () => writeOutputFile(outputPathFrom(args), content) }),
  );
}

function mockChildProcess({ exitCode = 0, onInput }) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    end: vi.fn(() => {
      onInput?.();
      setImmediate(() => child.emit("close", exitCode, null));
    }),
  };
  return child;
}

function outputPathFrom(args) {
  return args[args.indexOf("--output-last-message") + 1];
}

function writeOutputFile(path, content) {
  writeFileSync(path, content);
}
