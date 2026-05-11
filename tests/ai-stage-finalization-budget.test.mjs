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
        stopWhen: [expect.any(Function), { count: 190 }],
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
        stopWhen: [expect.any(Function), { count: 5 }],
      }),
    );
  });

  it("does not stop on schema-invalid output validator calls", async () => {
    generateText.mockResolvedValueOnce({
      steps: [
        {
          toolCalls: [
            {
              input: { content: '{"stage":"wrong","status":"completed"}' },
              toolName: "output_validator",
            },
          ],
        },
      ],
      text: "{}",
    });

    await expect(runImplementWithBudget(5, stageSchema())).rejects.toThrow(
      "AI output failed schema validation",
    );

    const [stopOnValidOutput] = generateText.mock.calls[0][0].stopWhen;
    await expect(
      stopOnValidOutput({
        steps: [
          {
            toolCalls: [
              {
                input: { content: '{"stage":"wrong","status":"completed"}' },
                toolName: "output_validator",
              },
            ],
          },
        ],
      }),
    ).resolves.toBe(false);
    await expect(
      stopOnValidOutput({
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
      }),
    ).resolves.toBe(true);
  });
});

describe("AI stage finalization continuation", () => {
  it("continues the same conversation when the primary turn budget is exhausted", async () => {
    const history = [{ content: "primary response history", role: "assistant" }];
    generateText.mockResolvedValueOnce({
      response: { messages: history },
      steps: Array.from({ length: 15 }, () => ({ toolCalls: [{ toolName: "read" }] })),
      text: "not final json",
    });
    mockOutput();

    await expect(runImplementWithBudget(25)).resolves.toBe(
      '{"stage":"implement","status":"completed"}',
    );

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(generateText.mock.calls[1][0]).toMatchObject({
      activeTools: ["output_validator"],
      toolChoice: { type: "tool", toolName: "output_validator" },
    });
    expect(generateText.mock.calls[1][0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "primary response history", role: "assistant" }),
        expect.objectContaining({
          content: expect.stringContaining("Previous validation error"),
          role: "user",
        }),
      ]),
    );
  });

  it("rejects when reserved finalization also fails to call the validator", async () => {
    generateText.mockResolvedValueOnce({ steps: [], text: "not json" });
    generateText.mockResolvedValueOnce({ steps: [], text: "still not json" });

    await expect(runImplementWithBudget(25)).rejects.toThrow(
      "AI response did not call output_validator",
    );
  });
});

/**
 * @param {number} maxTurns
 */
function runImplementWithBudget(maxTurns, schema = {}) {
  return runAiStage({
    config: config(),
    cwd: process.cwd(),
    maxTurns,
    prompt: "Prompt",
    reserveFinalizationTurns: true,
    schema,
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

function stageSchema() {
  return {
    additionalProperties: true,
    properties: {
      stage: { const: "implement" },
      status: { type: "string" },
    },
    required: ["stage", "status"],
    type: "object",
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
