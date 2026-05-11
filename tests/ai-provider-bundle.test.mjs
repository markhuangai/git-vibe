// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.fn();
const createOpenAI = vi.fn(() => ({ chat: vi.fn(() => "openai-model") }));
const createAnthropic = vi.fn(() => ({ languageModel: vi.fn(() => "anthropic-model") }));

vi.mock("ai", () => ({
  generateText,
  hasToolCall: vi.fn((toolName) => ({ toolName })),
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
    GITVIBE_AI_ENV_JSON: JSON.stringify({
      GITVIBE_AI_API_KEY: "test-key",
      GITVIBE_AI_BASE_URL: "https://proxy.test/v1",
    }),
  };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("AI stage runner provider bundle config", () => {
  it("requires provider api_key bundle sources", async () => {
    await expect(runInvestigate(configWithoutApiKey())).rejects.toThrow(
      "ai.profiles.local_proxy.provider.api_key.from_bundle must be configured for ai-sdk-agentool profile.",
    );
  });

  it("treats empty native OpenAI base URL bundle values as unset", async () => {
    process.env.GITVIBE_AI_ENV_JSON = JSON.stringify({
      GITVIBE_AI_API_KEY: "test-key",
      GITVIBE_AI_BASE_URL: "",
    });
    generateText.mockResolvedValueOnce(aiResult("investigate"));

    await expect(
      runInvestigate(nativeOpenAiConfig({ baseUrl: { from_bundle: "GITVIBE_AI_BASE_URL" } })),
    ).resolves.toBe('{"stage":"investigate","status":"completed"}');

    expect(createOpenAI).toHaveBeenCalledWith(expect.objectContaining({ baseURL: undefined }));
  });
});

function runInvestigate(config) {
  return runAiStage({
    config,
    cwd: process.cwd(),
    maxTurns: 1,
    prompt: "Prompt",
    schema: {},
    schemaId: "schema",
    stage: "investigate",
    stageDefinition: stageDefinitions.investigate,
    system: "System",
  });
}

function aiResult(stage) {
  const content = JSON.stringify({ stage, status: "completed" });
  return {
    steps: [{ toolCalls: [{ input: { content }, toolName: "output_validator" }] }],
    text: content,
  };
}

function configWithoutApiKey() {
  return {
    ai: {
      profiles: {
        local_proxy: {
          provider: {
            base_url: { from_bundle: "GITVIBE_AI_BASE_URL" },
            model: "glm-5",
            type: "openai-compatible",
          },
        },
      },
      stages: { investigate: { profile: "local_proxy" } },
    },
  };
}

function nativeOpenAiConfig({ baseUrl } = {}) {
  return {
    ai: {
      profiles: {
        openai: {
          provider: {
            api_key: { from_bundle: "GITVIBE_AI_API_KEY" },
            ...(baseUrl === undefined ? {} : { base_url: baseUrl }),
            model: "gpt-test",
            type: "openai",
          },
        },
      },
      stages: { investigate: { profile: "openai" } },
    },
  };
}
