import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.fn();
const createOpenAI = vi.fn(() => ({ chat: vi.fn(() => "openai-model") }));

vi.mock("ai", () => ({
  generateText,
  stepCountIs: vi.fn((count) => ({ count })),
}));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI }));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => ({ languageModel: vi.fn(() => "anthropic-model") })),
}));

const { runAiStage } = await import("../src/runner/ai.ts");
const { stageDefinitions } = await import("../src/shared/stages.ts");

const originalEnv = { ...process.env };

beforeEach(() => {
  generateText.mockReset();
  createOpenAI.mockClear();
  process.env = {
    ...originalEnv,
    GITVIBE_AI_ENV_JSON: JSON.stringify({
      OPENAI_BASE_URL: "https://proxy.test/v1",
      OPENAI_KEY: "openai-key",
    }),
  };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("AI output validator stop condition", () => {
  it("continues with fallback assistant text when no validator content is returned", async () => {
    generateText.mockResolvedValueOnce({ text: "" });
    generateText.mockResolvedValueOnce(aiResult("implement"));

    await expect(runImplement({ maxTurns: 25 })).resolves.toBe(
      '{"stage":"implement","status":"completed"}',
    );

    expect(generateText.mock.calls[1][0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: "No final assistant text was returned.",
          role: "assistant",
        }),
      ]),
    );
  });

  it("uses default OpenAI-compatible provider type and allows bash-readonly override", async () => {
    generateText.mockResolvedValueOnce(aiResult("implement"));

    await expect(
      runImplement({
        config: defaultProviderConfig(),
        toolOverride: ["bash-readonly"],
      }),
    ).resolves.toBe('{"stage":"implement","status":"completed"}');

    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "https://proxy.test/v1" }),
    );
    expect(Object.keys(generateText.mock.calls[0][0].tools)).toEqual(["output_validator", "bash"]);
  });

  it("rejects tool overrides outside the stage tool boundary", async () => {
    await expect(runImplement({ toolOverride: ["web-search"] })).rejects.toThrow(
      "AI tool override for implement includes disallowed tools: web-search.",
    );
  });
});

function runImplement(overrides = {}) {
  return runAiStage({
    config: config(),
    cwd: process.cwd(),
    maxTurns: 5,
    prompt: "Prompt",
    reserveFinalizationTurns: true,
    schema: {},
    schemaId: "schema",
    stage: "implement",
    stageDefinition: stageDefinitions.implement,
    system: "System",
    ...overrides,
  });
}

/**
 * @param {string} stage
 */
function aiResult(stage) {
  const content = JSON.stringify({ stage, status: "completed" });
  return {
    steps: [{ toolCalls: [{ input: { content }, toolName: "output_validator" }] }],
    text: content,
  };
}

function config() {
  return {
    ai: {
      profiles: {
        test: {
          provider: {
            api_key: { from_bundle: "OPENAI_KEY" },
            base_url: { from_bundle: "OPENAI_BASE_URL" },
            model: "gpt-test",
            type: "openai-compatible",
          },
        },
      },
      stages: { implement: { profile: "test" } },
    },
  };
}

function defaultProviderConfig() {
  return {
    ai: {
      profiles: {
        test: {
          provider: {
            api_key: { from_bundle: "OPENAI_KEY" },
            base_url: { from_bundle: "OPENAI_BASE_URL" },
            model: "gpt-test",
          },
        },
      },
      stages: { implement: { profile: "test" } },
    },
  };
}
