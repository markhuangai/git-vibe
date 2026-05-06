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
  createOpenAI.mockClear();
  createAnthropic.mockClear();
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

describe("AI stage runner OpenAI-compatible profiles", () => {
  it("calls AI SDK with provider config, tools, and tool telemetry", async () => {
    process.env.OPENAI_KEY = "openai-key";
    process.env.OPENAI_MODEL = "gpt-test";
    process.env.OPENAI_BASE_URL = "https://proxy.test/v1";
    const logger = { event: vi.fn() };
    generateText.mockImplementationOnce(async (request) => {
      request.experimental_onToolCallStart({ toolCall: { toolName: "read" } });
      request.experimental_onToolCallFinish({ success: true, toolName: "read" });
      request.experimental_onToolCallFinish({ error: new Error("denied"), toolName: "bash" });
      request.onStepFinish({ finishReason: "stop", toolCalls: [{ toolName: "read" }] });
      return {
        steps: [{ toolCalls: [{ toolName: "output_validator" }] }],
        text: '{"stage":"investigate","status":"completed"}',
      };
    });

    await expect(
      runAiStage({
        config: openAiCompatibleConfig(),
        cwd: process.cwd(),
        logger,
        maxTurns: 3,
        prompt: "Prompt",
        schema: {},
        schemaId: "schema",
        stageDefinition: stageDefinitions.investigate,
        system: "System",
      }),
    ).resolves.toBe('{"stage":"investigate","status":"completed"}');

    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "openai-key", baseURL: "https://proxy.test/v1" }),
    );
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRetries: 0,
        prompt: "Prompt",
        providerOptions: { custom: true },
        stopWhen: { count: 3 },
        system: "System",
        temperature: 0.5,
      }),
    );
    expect(logger.event).toHaveBeenCalledWith("ai.request.start", expect.any(Object));
    expect(logger.event).toHaveBeenCalledWith("ai.tool.start", { tool: "read" });
    expect(logger.event).toHaveBeenCalledWith("ai.tool.done", {
      error: undefined,
      tool: "read",
    });
    expect(logger.event).toHaveBeenCalledWith("ai.tool.failed", {
      error: "denied",
      tool: "bash",
    });
  });
});

describe("AI stage runner provider failures", () => {
  it("supports anthropic profiles and reports malformed AI responses", async () => {
    process.env.ANTHROPIC_KEY = "anthropic-key";
    process.env.ANTHROPIC_MODEL = "claude-test";
    generateText.mockResolvedValueOnce({ steps: [], text: "not json" });

    await expect(
      runAiStage({
        config: anthropicConfig(),
        cwd: process.cwd(),
        maxTurns: 1,
        prompt: "Prompt",
        schema: {},
        schemaId: "schema",
        stageDefinition: stageDefinitions.summarize,
        system: "System",
      }),
    ).rejects.toThrow("AI response did not contain a JSON object");

    expect(createAnthropic).toHaveBeenCalledWith({ apiKey: "anthropic-key" });
  });

  it("requires configured AI environment variables", async () => {
    delete process.env.GITVIBE_AI_MODEL;

    await expect(
      runAiStage({
        config: {},
        cwd: process.cwd(),
        maxTurns: 1,
        prompt: "Prompt",
        schema: {},
        schemaId: "schema",
        stageDefinition: stageDefinitions.investigate,
        system: "System",
      }),
    ).rejects.toThrow("GITVIBE_AI_MODEL is required");
  });
});

describe("AI stage runner telemetry edge cases", () => {
  it("handles OpenAI profiles without a base URL and unknown tool telemetry shapes", async () => {
    delete process.env.GITVIBE_AI_BASE_URL;
    const logger = { event: vi.fn() };
    generateText.mockImplementationOnce(async (request) => {
      request.experimental_onToolCallStart(undefined);
      request.experimental_onToolCallStart({ toolCall: {} });
      request.experimental_onToolCallFinish(undefined);
      request.experimental_onToolCallFinish({ success: false });
      request.onStepFinish(undefined);
      return { text: '{"stage":"summarize","status":"completed"}' };
    });

    await expect(
      runAiStage({
        config: nativeOpenAiConfig(),
        cwd: process.cwd(),
        logger,
        maxTurns: 1,
        prompt: "Prompt",
        schema: {},
        schemaId: "schema",
        stageDefinition: { tools: ["bash-readonly"] },
        system: "System",
      }),
    ).resolves.toBe('{"stage":"summarize","status":"completed"}');

    expect(createOpenAI).toHaveBeenCalledWith(expect.objectContaining({ baseURL: undefined }));
    expect(logger.event).toHaveBeenCalledWith("ai.tool.start", { tool: "<unknown>" });
    expect(logger.event).toHaveBeenCalledWith("ai.tool.failed", {
      error: "undefined",
      tool: "<unknown>",
    });
    expect(logger.event).toHaveBeenCalledWith("ai.step.done", {
      finish_reason: undefined,
      step: 1,
      tool_calls: 0,
    });
    expect(logger.event).toHaveBeenCalledWith("ai.request.done", {
      steps: 1,
      tool_calls: 0,
    });
  });
});

function openAiCompatibleConfig() {
  return {
    ai: {
      default_profile: "test",
      profiles: {
        test: {
          generation: { temperature: 0.5 },
          provider: {
            api_key_secret: "OPENAI_KEY",
            base_url_variable: "OPENAI_BASE_URL",
            model_variable: "OPENAI_MODEL",
            type: "openai-compatible",
          },
          provider_options: { custom: true },
        },
      },
    },
  };
}

function anthropicConfig() {
  return {
    ai: {
      default_profile: "claude",
      profiles: {
        claude: {
          provider: {
            api_key_secret: "ANTHROPIC_KEY",
            model_variable: "ANTHROPIC_MODEL",
            type: "anthropic",
          },
        },
      },
    },
  };
}

function nativeOpenAiConfig() {
  return {
    ai: {
      default_profile: "openai",
      profiles: {
        openai: {
          provider: {
            type: "openai",
          },
        },
      },
    },
  };
}
