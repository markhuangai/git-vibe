// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.fn();
const createOpenAI = vi.fn(() => ({ chat: vi.fn(() => "openai-model") }));
const createAnthropic = vi.fn(() => ({ languageModel: vi.fn(() => "anthropic-model") }));

vi.mock("ai", () => ({
  generateText,
  stepCountIs: vi.fn((count) => ({ count })),
}));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic }));

const { runAiStage } = await import("../src/runner/ai.ts");
const { stageDefinitions } = await import("../src/shared/stages.ts");

const originalEnv = { ...process.env };

beforeEach(() => {
  generateText.mockReset();
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

describe("AI usage telemetry", () => {
  it("logs provider token usage and configured context pressure", async () => {
    const logger = { event: vi.fn() };
    mockUsageResult({
      stepUsage: usage({
        inputCacheReadTokens: 80,
        inputCacheWriteTokens: 20,
        inputNoCacheTokens: 150,
        inputTokens: 250,
        outputReasoningTokens: 8,
        outputTextTokens: 12,
        outputTokens: 20,
        totalTokens: 270,
      }),
      totalUsage: usage({
        inputCacheReadTokens: 100,
        inputCacheWriteTokens: 30,
        inputNoCacheTokens: 200,
        inputTokens: 330,
        outputReasoningTokens: 12,
        outputTextTokens: 18,
        outputTokens: 30,
        totalTokens: 360,
      }),
    });

    await runUsageStage({ config: configWithProfile({ context_window_tokens: 1000 }), logger });

    expect(eventFields(logger, "ai.request.start")).toMatchObject({ context_window_tokens: 1000 });
    expect(eventFields(logger, "ai.step.done")).toMatchObject({
      context_used_pct: 25,
      input_cache_read_tokens: 80,
      input_cache_write_tokens: 20,
      input_no_cache_tokens: 150,
      input_tokens: 250,
      output_reasoning_tokens: 8,
      output_text_tokens: 12,
      output_tokens: 20,
      total_tokens: 270,
    });
    expect(eventFields(logger, "ai.request.done")).toMatchObject({
      input_cache_read_tokens: 100,
      input_cache_write_tokens: 30,
      input_no_cache_tokens: 200,
      input_tokens: 330,
      max_context_used_pct: 25,
      output_reasoning_tokens: 12,
      output_text_tokens: 18,
      output_tokens: 30,
      total_tokens: 360,
    });
  });

  it("logs context percentages from the default context window budget", async () => {
    const logger = { event: vi.fn() };
    mockUsageResult({
      stepUsage: usage({ inputTokens: 100, outputTokens: 20, totalTokens: 120 }),
      totalUsage: usage({ inputTokens: 100, outputTokens: 20, totalTokens: 120 }),
    });

    await runUsageStage({ config: configWithProfile(), logger });

    expect(eventFields(logger, "ai.request.start")).toMatchObject({
      context_window_tokens: 200000,
    });
    expect(eventFields(logger, "ai.step.done")).toMatchObject({
      context_used_pct: 0.1,
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
    });
    expect(eventFields(logger, "ai.request.done")).toMatchObject({ max_context_used_pct: 0.1 });
  });

  it("rejects invalid context window telemetry config", async () => {
    await expect(
      runUsageStage({ config: configWithProfile({ context_window_tokens: 0 }) }),
    ).rejects.toThrow("AI profile test context_window_tokens must be a positive integer");
  });
});

function mockUsageResult({ stepUsage, totalUsage }) {
  generateText.mockImplementationOnce(async (request) => {
    request.onStepFinish({ finishReason: "stop", toolCalls: [], usage: stepUsage });
    return {
      steps: [{ toolCalls: [] }],
      text: '{"stage":"summarize","status":"completed"}',
      totalUsage,
    };
  });
}

async function runUsageStage({ config, logger = { event: vi.fn() } }) {
  return runAiStage({
    config,
    cwd: process.cwd(),
    logger,
    maxTurns: 1,
    prompt: "Prompt",
    schema: {},
    schemaId: "schema",
    stage: "investigate",
    stageDefinition: stageDefinitions.investigate,
    system: "System",
  });
}

function usage({
  inputCacheReadTokens,
  inputCacheWriteTokens,
  inputNoCacheTokens,
  inputTokens,
  outputReasoningTokens,
  outputTextTokens,
  outputTokens,
  totalTokens,
}) {
  return {
    inputTokenDetails: {
      cacheReadTokens: inputCacheReadTokens,
      cacheWriteTokens: inputCacheWriteTokens,
      noCacheTokens: inputNoCacheTokens,
    },
    inputTokens,
    outputTokenDetails: {
      reasoningTokens: outputReasoningTokens,
      textTokens: outputTextTokens,
    },
    outputTokens,
    totalTokens,
  };
}

function eventFields(logger, eventName) {
  return logger.event.mock.calls.find(([name]) => name === eventName)?.[1] || {};
}

function configWithProfile(profileFields = {}) {
  return {
    ai: {
      profiles: {
        test: {
          ...profileFields,
          provider: {
            api_key_secret: "GITVIBE_AI_API_KEY",
            base_url_variable: "GITVIBE_AI_BASE_URL",
            model: "glm-5",
            type: "openai-compatible",
          },
        },
      },
      stages: {
        investigate: {
          profile: "test",
        },
      },
    },
  };
}
