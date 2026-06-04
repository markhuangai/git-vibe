import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCliMcpConfig } from "../src/runner/mcp-cli-config.ts";
import { stageDefinitions } from "../src/shared/stages.ts";

const originalEnv = { ...process.env };
const validateStage = /** @type {import("../src/shared/types.ts").Stage} */ ("validate");

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("CLI MCP gateway configuration", () => {
  it("writes gateway configs and adapter args for model-callable MCP tools", () => {
    process.env = {
      ...originalEnv,
      GITVIBE_MCP_ENV_JSON: JSON.stringify({ DENSE_MEM_TOKEN: "dense-token" }),
    };
    const contextDir = mkdtempSync(join(tmpdir(), "git-vibe-mcp-cli-"));

    try {
      const result = prepareCliMcpConfig({
        contextDir,
        options: runAiStageOptions(mcpConfig(), { logger: { event: vi.fn() } }),
      });

      const gatewayConfigPath = join(contextDir, "mcp-gateway", "dense_mem.json");
      const gatewayConfig = JSON.parse(readFileSync(gatewayConfigPath, "utf8"));
      expect(statSync(gatewayConfigPath).mode & 0o777).toBe(0o600);
      expect(gatewayConfig).toMatchObject({
        allowTools: ["search_memory"],
        required: true,
        server: {
          command: "node",
          env: { DENSE_MEM_TOKEN: "dense-token" },
          name: "dense_mem",
          secretValues: ["dense-token"],
          transport: "stdio",
        },
      });
      expect(gatewayConfig.server.env.GITVIBE_MCP_ENV_JSON).toBeUndefined();

      expect(result.codexConfigArgs).toEqual(
        expect.arrayContaining([
          "-c",
          "mcp_servers.dense_mem.enabled=true",
          "-c",
          `mcp_servers.dense_mem.command=${JSON.stringify(process.execPath)}`,
          "-c",
          `mcp_servers.dense_mem.env.GITVIBE_MCP_GATEWAY_CONFIG=${JSON.stringify(
            gatewayConfigPath,
          )}`,
          "-c",
          'mcp_servers.dense_mem.tools.search_memory.approval_mode="approve"',
        ]),
      );
      expect(result.codexConfigArgs).toContain(
        `mcp_servers.dense_mem.args=[${JSON.stringify(gatewayScriptPath())}]`,
      );

      const mcpConfigArg = result.claudeArgs[result.claudeArgs.indexOf("--mcp-config") + 1];
      expect(JSON.parse(mcpConfigArg)).toEqual({
        mcpServers: {
          dense_mem: {
            args: [gatewayScriptPath()],
            command: process.execPath,
            env: { GITVIBE_MCP_GATEWAY_CONFIG: gatewayConfigPath },
          },
        },
      });
      expect(result.claudeArgs).toEqual(
        expect.arrayContaining([
          "--strict-mcp-config",
          "--allowedTools",
          "mcp__dense_mem__search_memory",
        ]),
      );
    } finally {
      rmSync(contextDir, { force: true, recursive: true });
    }
  });
});

describe("CLI MCP gateway configuration fallbacks", () => {
  it("omits CLI MCP config when a stage has no model allowlist", () => {
    const contextDir = mkdtempSync(join(tmpdir(), "git-vibe-mcp-cli-empty-"));

    try {
      expect(
        prepareCliMcpConfig({
          contextDir,
          options: runAiStageOptions({
            ai: {
              mcp: { servers: { dense_mem: { command: "node" } } },
              stages: {
                validate: {
                  mcp: {
                    dense_mem: {
                      allow_tools: { context: ["recall"] },
                      context_calls: [{ tool: "recall" }],
                    },
                  },
                },
              },
            },
          }),
        }),
      ).toEqual({ claudeArgs: [], codexConfigArgs: [] });
    } finally {
      rmSync(contextDir, { force: true, recursive: true });
    }
  });

  it("uses the checked-out action path for gateway scripts when available", () => {
    process.env = {
      ...originalEnv,
      GITHUB_ACTION_PATH: "/opt/git-vibe/actions/review-matrix",
      GITVIBE_MCP_ENV_JSON: JSON.stringify({ DENSE_MEM_TOKEN: "dense-token" }),
    };
    const contextDir = mkdtempSync(join(tmpdir(), "git-vibe-mcp-cli-action-path-"));

    try {
      const result = prepareCliMcpConfig({
        contextDir,
        options: runAiStageOptions(mcpConfig()),
      });
      const expectedGateway = resolve(
        "/opt/git-vibe/actions/review-matrix",
        "..",
        "dist",
        "actions",
        "mcp-gateway.js",
      );
      const mcpConfigArg = result.claudeArgs[result.claudeArgs.indexOf("--mcp-config") + 1];
      expect(JSON.parse(mcpConfigArg).mcpServers.dense_mem.args).toEqual([expectedGateway]);
      expect(result.codexConfigArgs).toContain(
        `mcp_servers.dense_mem.args=[${JSON.stringify(expectedGateway)}]`,
      );
    } finally {
      rmSync(contextDir, { force: true, recursive: true });
    }
  });

  it("skips optional model MCP gateway config when credentials are missing", () => {
    process.env = { ...originalEnv, GITVIBE_MCP_ENV_JSON: "{}" };
    const contextDir = mkdtempSync(join(tmpdir(), "git-vibe-mcp-cli-missing-optional-"));
    const logger = { event: vi.fn() };

    try {
      expect(
        prepareCliMcpConfig({
          contextDir,
          options: runAiStageOptions(optionalMcpConfig(), { logger }),
        }),
      ).toEqual({ claudeArgs: [], codexConfigArgs: [] });
      expect(logger.event).toHaveBeenCalledWith("mcp.cli_config.warning", {
        reason: expect.stringContaining("GITVIBE_MCP_ENV_JSON key DENSE_MEM_TOKEN is required"),
        server: "dense_mem",
      });
    } finally {
      rmSync(contextDir, { force: true, recursive: true });
    }
  });
});

/**
 * @param {import("../src/shared/types.ts").GitVibeConfig} config
 * @param {Partial<import("../src/runner/ai.ts").RunAiStageOptions>} [overrides]
 * @returns {import("../src/runner/ai.ts").RunAiStageOptions}
 */
function runAiStageOptions(config, overrides = {}) {
  return {
    config,
    cwd: process.cwd(),
    maxTurns: 1,
    prompt: "Prompt",
    schema: {},
    schemaId: "schema",
    stage: validateStage,
    stageDefinition: stageDefinitions.validate,
    system: "System",
    ...overrides,
  };
}

function mcpConfig() {
  return {
    ai: {
      mcp: {
        servers: {
          dense_mem: {
            command: "node",
            env: {
              DENSE_MEM_TOKEN: { from_bundle: "DENSE_MEM_TOKEN" },
            },
          },
        },
      },
      stages: {
        validate: {
          mcp: {
            dense_mem: {
              allow_tools: {
                model: ["search_memory"],
              },
            },
          },
        },
      },
    },
  };
}

function optionalMcpConfig() {
  const config = mcpConfig();
  /** @type {any} */ (config.ai.stages.validate.mcp.dense_mem).required = false;
  return config;
}

function gatewayScriptPath() {
  return resolve(process.cwd(), "dist", "actions", "mcp-gateway.js");
}
