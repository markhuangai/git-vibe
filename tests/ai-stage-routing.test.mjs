// @ts-nocheck
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
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
const { activeProfileByName } = await import("../src/runner/ai-config.ts");
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
      GITVIBE_AI_API_KEY: "test-key",
      GITVIBE_AI_BASE_URL: "https://proxy.test/v1",
      STAGE_BASE_URL: "https://stage.test/v1",
      STAGE_KEY: "stage-key",
    }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("AI stage runner stage routing", () => {
  it("uses runtime stage IDs for profile and tool overrides", async () => {
    const logger = { event: vi.fn() };
    generateText.mockResolvedValueOnce(aiResult("validate"));

    await expect(
      runAiStage({
        config: stageRoutingConfig(),
        cwd: process.cwd(),
        logger,
        maxTurns: 2,
        prompt: "Prompt",
        schema: {},
        schemaId: "schema",
        stage: "validate",
        stageDefinition: stageDefinitions.validate,
        system: "System",
      }),
    ).resolves.toBe('{"stage":"validate","status":"completed"}');

    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "stage-key", baseURL: "https://stage.test/v1" }),
    );
    expect(generateText.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        temperature: 0.1,
        tools: expect.objectContaining({
          output_validator: expect.any(Object),
          read: expect.any(Object),
        }),
      }),
    );
    expect(Object.keys(generateText.mock.calls[0][0].tools).sort()).toEqual([
      "output_validator",
      "read",
    ]);
    expect(logger.event).toHaveBeenCalledWith(
      "ai.request.start",
      expect.objectContaining({
        model: "stage-model",
        profile: "validation_profile",
        tools: "output_validator,read",
      }),
    );
  });

  it("rejects stage tool overrides that expand canonical stage permissions", async () => {
    await expectValidationConfigError(
      validationConfigWithStage({ tools: ["read", "edit"] }),
      "ai.stages.validate.tools includes disallowed tools: edit.",
    );

    expect(generateText).not.toHaveBeenCalled();
  });
});

describe("AI stage runner explicit profile routing", () => {
  it("requires explicit stage profile routing", async () => {
    await expectValidationConfigError(
      {
        ai: {
          profiles: {
            local_proxy: { provider: { type: "openai-compatible" } },
          },
        },
      },
      "ai.stages.validate must define profile or profiles.",
    );
    await expectValidationConfigError(
      {
        ai: {
          profiles: {
            local_proxy: { provider: { type: "openai-compatible" } },
          },
          stages: {
            investigate: {
              profile: "local_proxy",
            },
          },
        },
      },
      "ai.stages.validate must define profile or profiles.",
    );
    await expectValidationConfigError(
      {
        ai: {
          default_profile: "local_proxy",
          profiles: {
            local_proxy: { provider: { type: "openai-compatible" } },
          },
          stages: {
            validate: {
              tools: ["read"],
            },
          },
        },
      },
      "ai.stages.validate must define profile or profiles.",
    );
    await expectValidationConfigError(
      {
        ai: {
          profiles: {
            local_proxy: { provider: { type: "openai-compatible" } },
          },
          stages: {
            validate: {
              profile: "missing_profile",
            },
          },
        },
      },
      "ai.profiles.missing_profile must be configured.",
    );
  });

  it("rejects malformed named profile config", async () => {
    expect(() => activeProfileByName({}, "local_proxy")).toThrow("ai.profiles must be an object.");
    await expectValidationConfigError(
      {
        ai: {
          profiles: [],
          stages: {
            validate: {
              profile: "local_proxy",
            },
          },
        },
      },
      "ai.profiles must be an object.",
    );
    await expectValidationConfigError(
      {
        ai: {
          profiles: {
            local_proxy: "enabled",
          },
          stages: {
            validate: {
              profile: "local_proxy",
            },
          },
        },
      },
      "ai.profiles.local_proxy must be an object.",
    );
  });
});

describe("AI stage runner stage config validation", () => {
  it("enforces disabled stage config", async () => {
    await expectValidationConfigError(
      { ai: { stages: { validate: { enabled: false } } } },
      "ai.stages.validate is disabled.",
    );
  });

  it("rejects malformed stage routing config", async () => {
    await expectValidationConfigError({ ai: { stages: [] } }, "ai.stages must be an object.");
    await expectValidationConfigError(
      { ai: { stages: { validate: [] } } },
      "ai.stages.validate must be an object.",
    );
    await expectValidationConfigError(
      { ai: { stages: { validate: { enabled: "yes" } } } },
      "ai.stages.validate.enabled must be a boolean.",
    );
    await expectValidationConfigError(
      validationConfigWithStage({ tools: ["read", ""] }),
      "ai.stages.validate.tools must be a string array.",
    );
  });

  it("rejects malformed stage profile arrays", async () => {
    await expectValidationConfigError(
      { ai: { stages: { validate: { profiles: [] } } } },
      "Stage AI config profiles must be a non-empty string array.",
    );
    await expectValidationConfigError(
      { ai: { stages: { validate: { profiles: ["local_proxy", ""] } } } },
      "Stage AI config profiles must be a non-empty string array.",
    );
    await expectValidationConfigError(
      { ai: { stages: { validate: { profile: "local_proxy", profiles: ["local_proxy"] } } } },
      "Stage AI config cannot define both profile and profiles.",
    );
  });
});

describe("AI stage runner stage fallbacks", () => {
  it("runs configured Codex CLI profiles with runtime stage context", async () => {
    process.env.GITVIBE_AI_ENV_JSON = JSON.stringify({ CODEX_AUTH_JSON: codexAuthJson("old") });
    mockCodexOutput('{"stage":"validate","status":"completed"}');
    const schema = {
      additionalProperties: false,
      properties: {
        stage: { type: "string" },
        working_capabilities: { items: { type: "string" }, type: "array" },
      },
      required: ["stage"],
      type: "object",
    };

    await expect(runAiStage({ ...validateStageOptions(codexCliConfig()), schema })).resolves.toBe(
      '{"stage":"validate","status":"completed"}',
    );

    expect(spawn).toHaveBeenCalledWith(
      "codex",
      expect.arrayContaining([
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--cd",
        process.cwd(),
        "--model",
        "gpt-5.5",
        "-c",
        'model_reasoning_effort="xhigh"',
        "-c",
        'model_reasoning_summary="concise"',
      ]),
      expect.objectContaining({
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(spawnedChildren[0].stdin.end).toHaveBeenCalledWith(
      expect.stringContaining("System\n\nPrompt"),
    );
    expect(process.stdout.write).toHaveBeenCalledWith("codex event\n");
    expect(JSON.parse(readFileSync(schemaPathFrom(spawn.mock.calls[0][1]), "utf8"))).toEqual(
      expect.objectContaining({
        required: ["stage", "working_capabilities"],
      }),
    );
    const childEnv = spawn.mock.calls[0][2].env;
    expect(readFileSync(join(childEnv.CODEX_HOME, "auth.json"), "utf8")).toBe(codexAuthJson("old"));
    expect(childEnv.CODEX_AUTH_JSON).toBeUndefined();
    expect(childEnv.GITVIBE_AI_ENV_JSON).toBeUndefined();
    expect(schema.required).toEqual(["stage"]);
    expect(generateText).not.toHaveBeenCalled();
  });
});

describe("AI stage runner Codex CLI defaults", () => {
  it("uses command, model, and auth defaults for Codex CLI profiles", async () => {
    mockCodexOutput('{"stage":"implement","status":"completed"}');

    await expect(
      runAiStage(
        implementStageOptions({
          ai: {
            profiles: {
              codex_cli: {
                adapter: "cli-codex",
                model: "codex-test-model",
              },
            },
            stages: {
              implement: {
                profile: "codex_cli",
              },
            },
          },
        }),
      ),
    ).resolves.toBe('{"stage":"implement","status":"completed"}');

    const args = spawn.mock.calls[0][1];
    expect(spawn.mock.calls[0][0]).toBe("codex");
    expect(args).toEqual(expect.arrayContaining(["exec", "--model", "codex-test-model"]));
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--sandbox");
    expect(args).not.toContain("-c");
    expect(spawn.mock.calls[0][2].env.CODEX_HOME).toBeUndefined();
  });

  it("requires a model for Codex CLI profiles", async () => {
    await expect(
      runAiStage(
        validateStageOptions({
          ai: {
            profiles: {
              codex_cli: {
                adapter: "cli-codex",
              },
            },
            stages: {
              validate: {
                profile: "codex_cli",
              },
            },
          },
        }),
      ),
    ).rejects.toThrow("AI profile model must be configured for cli-codex profile.");

    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("AI stage runner profile arrays", () => {
  it("uses stage profile arrays and removes duplicate profile names", async () => {
    generateText.mockResolvedValueOnce(aiResult("validate"));

    await expect(
      runAiStage(
        validateStageOptions({
          ai: {
            profiles: {
              local_proxy: {
                provider: {
                  api_key: { from_bundle: "GITVIBE_AI_API_KEY" },
                  base_url: { from_bundle: "GITVIBE_AI_BASE_URL" },
                  model: "test-model",
                  type: "openai-compatible",
                },
              },
            },
            stages: {
              validate: {
                profiles: ["local_proxy", "local_proxy"],
              },
            },
          },
        }),
      ),
    ).resolves.toBe('{"stage":"validate","status":"completed"}');

    expect(generateText).toHaveBeenCalledTimes(1);
  });
});

describe("AI stage runner fallback profiles", () => {
  it("retries the configured fallback profile when the primary profile fails", async () => {
    const logger = { event: vi.fn() };
    generateText.mockResolvedValueOnce(aiResult("investigate"));

    await expect(
      runAiStage({
        config: fallbackRoutingConfig(),
        cwd: process.cwd(),
        logger,
        maxTurns: 1,
        prompt: "Prompt",
        schema: {},
        schemaId: "schema",
        stage: "investigate",
        stageDefinition: stageDefinitions.investigate,
        system: "System",
      }),
    ).resolves.toBe('{"stage":"investigate","status":"completed"}');

    expect(logger.event).toHaveBeenCalledWith("ai.request.failed", {
      error:
        "GITVIBE_AI_ENV_JSON key PRIMARY_KEY is required by ai.profiles.primary.provider.api_key.from_bundle.",
      profile: "primary",
    });
    expect(logger.event).toHaveBeenCalledWith("ai.request.retry", {
      previous_error:
        "GITVIBE_AI_ENV_JSON key PRIMARY_KEY is required by ai.profiles.primary.provider.api_key.from_bundle.",
      profile: "fallback",
    });
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "fallback-key", baseURL: "https://fallback.test/v1" }),
    );
  });

  it("reports unsupported configured adapters instead of treating them as providers", async () => {
    await expect(
      runAiStage(
        validateStageOptions({
          ai: {
            profiles: {
              custom_cli: {
                adapter: "cli-custom",
              },
            },
            stages: {
              validate: {
                profile: "custom_cli",
              },
            },
          },
        }),
      ),
    ).rejects.toThrow("AI profile custom_cli uses unsupported adapter cli-custom.");
  });
});

async function expectValidationConfigError(config, message) {
  await expect(runAiStage(validateStageOptions(config))).rejects.toThrow(message);
}

function validationConfigWithStage(stageConfig) {
  return {
    ai: {
      profiles: {
        local_proxy: {
          provider: {
            type: "openai-compatible",
          },
        },
      },
      stages: {
        validate: {
          profile: "local_proxy",
          ...stageConfig,
        },
      },
    },
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

function mockCodexOutput(content) {
  spawn.mockImplementationOnce((_command, args) => {
    return mockChildProcess({
      onInput: () => writeFileSync(outputPathFrom(args), content),
      stdout: "codex event\n",
    });
  });
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

function schemaPathFrom(args) {
  return args[args.indexOf("--output-schema") + 1];
}

function codexAuthJson(label) {
  return `${JSON.stringify({
    auth_mode: "chatgpt",
    last_refresh: "2026-05-09T11:57:42.136804048Z",
    tokens: {
      access_token: `access-${label}`,
      account_id: "05eae55c-50ed-4afe-9a8f-4a3127e7d5a3",
      id_token: `header.${label}.signature`,
      refresh_token: `refresh-${label}`,
    },
  })}\n`;
}

function codexCliConfig() {
  return {
    ai: {
      profiles: {
        codex_cli: {
          adapter: "cli-codex",
          auth_json: { from_bundle: "CODEX_AUTH_JSON" },
          model: "gpt-5.5",
          reasoning: {
            effort: "xhigh",
            summary: "concise",
          },
        },
      },
      stages: {
        validate: {
          profile: "codex_cli",
        },
      },
    },
  };
}

function aiResult(stage) {
  const content = JSON.stringify({ stage, status: "completed" });
  return {
    steps: [{ toolCalls: [{ input: { content }, toolName: "output_validator" }] }],
    text: content,
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
