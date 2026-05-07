// @ts-nocheck
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { setImmediate } from "node:timers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.fn();
const createOpenAI = vi.fn(() => ({ chat: vi.fn(() => "openai-model") }));
const createAnthropic = vi.fn(() => ({ languageModel: vi.fn(() => "anthropic-model") }));
const spawn = vi.fn();
const spawnedChildren = [];

vi.mock("ai", () => ({
  generateText,
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
    GITVIBE_AI_API_KEY: "test-key",
    GITVIBE_AI_BASE_URL: "https://proxy.test/v1",
    GITVIBE_AI_MODEL: "test-model",
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("AI stage runner stage routing", () => {
  it("uses runtime stage IDs for profile and tool overrides", async () => {
    process.env.STAGE_KEY = "stage-key";
    process.env.STAGE_MODEL = "stage-model";
    process.env.STAGE_BASE_URL = "https://stage.test/v1";
    const logger = { event: vi.fn() };
    generateText.mockResolvedValueOnce({
      steps: [],
      text: '{"stage":"validate","status":"completed"}',
    });

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
      { ai: { stages: { validate: { tools: ["read", "edit"] } } } },
      "ai.stages.validate.tools includes disallowed tools: edit.",
    );

    expect(generateText).not.toHaveBeenCalled();
  });
});

describe("AI stage runner stage config validation", () => {
  it("enforces enabled and canonical access stage config", async () => {
    await expectValidationConfigError(
      { ai: { stages: { validate: { enabled: false } } } },
      "ai.stages.validate is disabled.",
    );
    await expectValidationConfigError(
      { ai: { stages: { validate: { access: "branch-write" } } } },
      "ai.stages.validate.access must match canonical access read-only.",
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
      { ai: { stages: { validate: { access: true } } } },
      "ai.stages.validate.access must be a string.",
    );
    await expectValidationConfigError(
      { ai: { stages: { validate: { tools: ["read", ""] } } } },
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
    process.env.CODEX_AUTH_JSON = '{"tokens":[]}\n';
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
        "--cd",
        process.cwd(),
        "--model",
        "gpt-5.5",
        "--sandbox",
        "read-only",
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
    expect(process.stdout.write).toHaveBeenCalledWith(Buffer.from("codex event\n"));
    expect(JSON.parse(readFileSync(schemaPathFrom(spawn.mock.calls[0][1]), "utf8"))).toEqual(
      expect.objectContaining({
        required: ["stage", "working_capabilities"],
      }),
    );
    expect(schema.required).toEqual(["stage"]);
    expect(generateText).not.toHaveBeenCalled();
  });
});

describe("AI stage runner Codex CLI defaults", () => {
  it("uses command, model, sandbox, and auth defaults for Codex CLI profiles", async () => {
    process.env.CODEX_MODEL = "codex-env-model";
    mockCodexOutput('{"stage":"implement","status":"completed"}');

    await expect(
      runAiStage(
        implementStageOptions({
          ai: {
            profiles: {
              codex_cli: {
                adapter: "cli-codex",
                model_variable: "CODEX_MODEL",
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
    expect(args).toEqual(expect.arrayContaining(["exec", "--model", "codex-env-model"]));
    expect(args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write"]));
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
                model_variable: "MISSING_CODEX_MODEL",
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
    ).rejects.toThrow("MISSING_CODEX_MODEL is required for cli-codex profile");

    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("AI stage runner profile arrays", () => {
  it("uses stage profile arrays and removes duplicate profile names", async () => {
    generateText.mockResolvedValueOnce({
      steps: [],
      text: '{"stage":"validate","status":"completed"}',
    });

    await expect(
      runAiStage(
        validateStageOptions({
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
    process.env.FALLBACK_KEY = "fallback-key";
    process.env.FALLBACK_MODEL = "fallback-model";
    process.env.FALLBACK_BASE_URL = "https://fallback.test/v1";
    const logger = { event: vi.fn() };
    generateText.mockResolvedValueOnce({
      steps: [],
      text: '{"stage":"investigate","status":"completed"}',
    });

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
      error: "PRIMARY_MODEL is required for ai-sdk-agentool profile",
      profile: "primary",
    });
    expect(logger.event).toHaveBeenCalledWith("ai.request.retry", {
      previous_error: "PRIMARY_MODEL is required for ai-sdk-agentool profile",
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

function codexCliConfig() {
  return {
    ai: {
      profiles: {
        codex_cli: {
          adapter: "cli-codex",
          auth_json_secret: "CODEX_AUTH_JSON",
          command: "codex exec",
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

function stageRoutingConfig() {
  return {
    ai: {
      default_profile: "default",
      profiles: {
        default: {
          provider: {
            type: "openai-compatible",
          },
        },
        validation_profile: {
          generation: { temperature: 0.1 },
          provider: {
            api_key_secret: "STAGE_KEY",
            base_url_variable: "STAGE_BASE_URL",
            model_variable: "STAGE_MODEL",
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
      default_profile: "default",
      profiles: {
        default: {
          provider: {
            type: "openai-compatible",
          },
        },
        fallback: {
          provider: {
            api_key_secret: "FALLBACK_KEY",
            base_url_variable: "FALLBACK_BASE_URL",
            model_variable: "FALLBACK_MODEL",
            type: "openai-compatible",
          },
        },
        primary: {
          provider: {
            model_variable: "PRIMARY_MODEL",
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
