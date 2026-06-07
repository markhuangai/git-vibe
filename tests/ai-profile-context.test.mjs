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
      FALLBACK_BASE_URL: "https://fallback.test/v1",
      FALLBACK_KEY: "fallback-key",
      STAGE_BASE_URL: "https://stage.test/v1",
      STAGE_KEY: "stage-key",
    }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("AI profile context routing", () => {
  it("adds context files configured on the active AI SDK profile to the system prompt", async () => {
    const cwd = contextWorkspace({ "PROFILE.md": "Use profile-specific repository guidance." });
    const config = stageRoutingConfig();
    config.ai.profiles.validation_profile.context = { files: ["PROFILE.md"] };
    generateText.mockResolvedValueOnce(aiResult("validate"));

    try {
      await expect(
        runAiStage({
          ...validateStageOptions(config),
          cwd,
        }),
      ).resolves.toBe('{"stage":"validate","status":"completed"}');

      expect(generateText.mock.calls[0][0].system).toContain(
        '<git_vibe_profile_context profile="validation_profile" path="PROFILE.md">',
      );
      expect(generateText.mock.calls[0][0].system).toContain(
        "Use profile-specific repository guidance.",
      );
      expect(generateText.mock.calls[0][0].prompt).toContain("Prompt");
      expect(generateText.mock.calls[0][0].prompt).toContain("output_validator");
    } finally {
      cleanupWorkspace(cwd);
    }
  });

  it("uses context files from the fallback profile when retrying", async () => {
    const cwd = contextWorkspace({ "FALLBACK.md": "Fallback profile guidance." });
    const config = fallbackRoutingConfig();
    config.ai.profiles.fallback.context = { files: ["FALLBACK.md"] };
    generateText.mockResolvedValueOnce(aiResult("investigate"));

    try {
      await expect(
        runAiStage({
          config,
          cwd,
          maxTurns: 1,
          prompt: "Prompt",
          schema: {},
          schemaId: "schema",
          stage: "investigate",
          stageDefinition: stageDefinitions.investigate,
          system: "System",
        }),
      ).resolves.toBe('{"stage":"investigate","status":"completed"}');

      expect(generateText.mock.calls[0][0].system).toContain(
        '<git_vibe_profile_context profile="fallback" path="FALLBACK.md">',
      );
      expect(generateText.mock.calls[0][0].system).toContain("Fallback profile guidance.");
    } finally {
      cleanupWorkspace(cwd);
    }
  });

  it("adds context files configured on Codex CLI profiles to stdin", async () => {
    const cwd = contextWorkspace({ "AGENTS.md": "Codex profile guidance." });
    mockCodexOutput('{"stage":"validate","status":"completed"}');

    try {
      await expect(
        runAiStage({
          ...validateStageOptions({
            ai: {
              profiles: {
                codex_cli: {
                  adapter: "cli-codex",
                  context: { files: ["AGENTS.md"] },
                  model: "codex-test-model",
                },
              },
              stages: {
                validate: {
                  profile: "codex_cli",
                },
              },
            },
          }),
          cwd,
        }),
      ).resolves.toBe('{"stage":"validate","status":"completed"}');

      expect(spawnedChildren[0].stdin.end).toHaveBeenCalledWith(
        expect.stringContaining(
          '<git_vibe_profile_context profile="codex_cli" path="AGENTS.md">\nCodex profile guidance.',
        ),
      );
    } finally {
      cleanupWorkspace(cwd);
    }
  });
});

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

function stageRoutingConfig() {
  return {
    ai: {
      profiles: {
        validation_profile: {
          generation: { temperature: 0.1 },
          provider: {
            api_key: { from_bundle: "STAGE_KEY" },
            base_url: { from_bundle: "STAGE_BASE_URL" },
            model: "stage-model",
            type: "openai-compatible",
          },
        },
      },
      stages: {
        validate: {
          profile: "validation_profile",
          tools: ["read"],
        },
      },
    },
  };
}

function fallbackRoutingConfig() {
  return {
    ai: {
      profiles: {
        fallback: {
          provider: {
            api_key: { from_bundle: "FALLBACK_KEY" },
            base_url: { from_bundle: "FALLBACK_BASE_URL" },
            model: "fallback-model",
            type: "openai-compatible",
          },
        },
        primary: {
          provider: {
            api_key: { from_bundle: "PRIMARY_KEY" },
            base_url: { from_bundle: "PRIMARY_BASE_URL" },
            model: "primary-model",
            type: "openai-compatible",
          },
        },
      },
      stages: {
        investigate: {
          fallback_profile: "fallback",
          profile: "primary",
        },
      },
    },
  };
}

function mockCodexOutput(content) {
  spawn.mockImplementationOnce((_command, args) =>
    mockChildProcess({
      onInput: () => writeFileSync(outputPathFrom(args), content),
      stdout: "codex event\n",
    }),
  );
}

function mockChildProcess({ exitCode = 0, onInput, stderr = "", stdout = "" }) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    end: vi.fn((input) => {
      onInput?.(input);
      setImmediate(() => {
        if (stdout) child.stdout.emit("data", Buffer.from(stdout));
        if (stderr) child.stderr.emit("data", Buffer.from(stderr));
        child.emit("close", exitCode, null);
      });
    }),
  };
  spawnedChildren.push(child);
  return child;
}

function outputPathFrom(args) {
  return args[args.indexOf("--output-last-message") + 1];
}

function aiResult(stage) {
  const content = JSON.stringify({ stage, status: "completed" });
  return {
    steps: [{ toolCalls: [{ input: { content }, toolName: "output_validator" }] }],
    text: content,
  };
}

function contextWorkspace(files) {
  const cwd = mkdtempSync(join(tmpdir(), "git-vibe-ai-profile-context-"));
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(cwd, path), content);
  }
  return cwd;
}

function cleanupWorkspace(cwd) {
  rmSync(cwd, { force: true, recursive: true });
}
