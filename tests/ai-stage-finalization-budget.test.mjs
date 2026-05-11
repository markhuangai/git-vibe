import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.fn();
const createOpenAI = vi.fn(() => ({ chat: vi.fn(() => "openai-model") }));

vi.mock("ai", () => ({
  generateText,
  hasToolCall: vi.fn((toolName) => ({ toolName })),
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

describe("AI stage finalization turn reserve", () => {
  it("reserves ten turns from large requested budgets", async () => {
    mockOutput();

    await expect(runImplementWithBudget(200)).resolves.toBe(
      '{"stage":"implement","status":"completed"}',
    );

    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        stopWhen: [{ toolName: "output_validator" }, { count: 190 }],
      }),
    );
  });

  it("does not reserve turns from small requested budgets", async () => {
    mockOutput();

    await expect(runImplementWithBudget(5)).resolves.toBe(
      '{"stage":"implement","status":"completed"}',
    );

    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        stopWhen: [{ toolName: "output_validator" }, { count: 5 }],
      }),
    );
  });
});

/**
 * @param {number} maxTurns
 */
function runImplementWithBudget(maxTurns) {
  return runAiStage({
    config: config(),
    cwd: process.cwd(),
    maxTurns,
    prompt: "Prompt",
    reserveFinalizationTurns: true,
    schema: {},
    schemaId: "schema",
    stage: "implement",
    stageDefinition: stageDefinitions.implement,
    system: "System",
  });
}

function mockOutput() {
  generateText.mockResolvedValueOnce({
    steps: [
      {
        toolCalls: [
          {
            input: { content: '{"stage":"implement","status":"completed"}' },
            toolName: "output_validator",
          },
        ],
      },
    ],
    text: "{}",
  });
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
