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
const { createStageLogger } = await import("../src/runner/logging.ts");
const { stageDefinitions } = await import("../src/shared/stages.ts");

const originalEnv = { ...process.env };

beforeEach(() => {
  generateText.mockReset();
  createOpenAI.mockClear();
  createAnthropic.mockClear();
  process.env = {
    ...originalEnv,
    GITVIBE_AI_ENV_JSON: JSON.stringify({
      GITVIBE_AI_API_KEY: "bundle-secret-value",
      GITVIBE_AI_BASE_URL: "https://proxy.test/v1",
    }),
  };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("AI SDK agentool IO logging", () => {
  it("prints redacted input and output groups by default", async () => {
    const messages = [];
    const logger = createStageLogger("implement", {
      write: (message) => messages.push(message),
    });
    generateText.mockResolvedValueOnce({
      steps: [
        {
          toolCalls: [
            {
              input: {
                content:
                  '{"stage":"implement","status":"completed","summary":"bundle-secret-value"}',
              },
              toolName: "output_validator",
            },
          ],
        },
      ],
      text: "raw bundle-secret-value",
    });

    await expect(
      runAiStage({
        config: localProxyConfig(),
        cwd: process.cwd(),
        logger,
        maxTurns: 2,
        prompt: `Prompt ${"x".repeat(250)} tail-marker bundle-secret-value`,
        schema: {},
        schemaId: "implement.v1",
        stage: "implement",
        stageDefinition: stageDefinitions.implement,
        system: "System bundle-secret-value",
      }),
    ).resolves.toContain("bundle-secret-value");

    const log = messages.join("\n");
    expect(log).toContain("::group::[git-vibe] implement ai-sdk-agentool input");
    expect(log).toContain("::group::[git-vibe] implement ai-sdk-agentool output");
    expect(log).toContain("--- system ---");
    expect(log).toContain("--- prompt ---");
    expect(log).toContain("--- raw_text ---");
    expect(log).toContain("--- extracted_json ---");
    expect(log).not.toContain("bundle-secret-value");
    expect(log).not.toContain("tail-marker");
    expect(log).toContain("IO section truncated at 200 chars");
    expect(log).toContain("<redacted:GITVIBE_AI_ENV_JSON.GITVIBE_AI_API_KEY>");
  });
});

function localProxyConfig() {
  return {
    ai: {
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
      stages: { implement: { profile: "local_proxy" } },
    },
  };
}
