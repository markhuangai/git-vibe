import { describe, expect, it } from "vitest";
import {
  modelMcpServersForStage,
  renderMcpTemplateValue,
  stageMcpServers,
} from "../src/runner/mcp-config.ts";

describe("MCP stage configuration resolution", () => {
  it("resolves stage MCP servers, allowlists, credentials, and context templates", () => {
    const env = {
      GITVIBE_AI_ENV_JSON: JSON.stringify({ AI_KEY: "hidden-ai" }),
      GITVIBE_GITHUB_TOKEN: "hidden-token",
      GITVIBE_MCP_ENV_JSON: JSON.stringify({
        DENSE_MEM_TOKEN: "dense-token",
        DOCS_TOKEN: "docs-token",
      }),
      PATH: "/bin",
    };

    const servers = stageMcpServers({
      config: mcpConfig(),
      env,
      stage: "review-matrix",
    });

    expect(servers).toHaveLength(2);
    expect(servers[0]).toMatchObject({
      allowContextTools: ["recall"],
      allowModelTools: ["search_memory"],
      contextCalls: [{ arguments: { query: "{{repository}}#{{pr_number}}" }, tool: "recall" }],
      required: false,
      server: {
        args: ["server.js"],
        command: "node",
        name: "dense_mem",
        secretValues: ["dense-token"],
        transport: "stdio",
      },
    });
    expect(servers[0].server.env).toMatchObject({
      DENSE_MEM_TOKEN: "dense-token",
      LITERAL_VALUE: "literal",
      PATH: "/bin",
    });
    expect(servers[0].server.env.GITVIBE_AI_ENV_JSON).toBeUndefined();
    expect(servers[0].server.env.GITVIBE_GITHUB_TOKEN).toBeUndefined();
    expect(servers[0].server.env.GITVIBE_MCP_ENV_JSON).toBeUndefined();
    expect(servers[1]).toMatchObject({
      allowContextTools: [],
      allowModelTools: ["lookup"],
      required: true,
      server: {
        headers: { Authorization: "docs-token" },
        name: "docs",
        secretValues: ["docs-token"],
        transport: "http",
        url: "https://mcp.example.test",
      },
    });
    expect(
      modelMcpServersForStage({ config: mcpConfig(), env, stage: "review-matrix" }),
    ).toHaveLength(2);
    expect(
      renderMcpTemplateValue(
        { nested: ["{{repository}}", "{{pr_number}}", "{{stage}}", "{{unknown_token}}"] },
        contextPacket(),
        runnerOptions(),
      ),
    ).toEqual({ nested: ["owner/repo", "42", "review-matrix", "{{unknown_token}}"] });
    expect(
      renderMcpTemplateValue("{{issue_number}}/{{pr_number}}", contextPacket(), {
        ...runnerOptions(),
        issueNumber: "9",
        prNumber: "",
      }),
    ).toBe("9/");
  });
});

describe("MCP stage configuration validation", () => {
  it("rejects invalid stage MCP references and allowlists", () => {
    expect(() =>
      stageMcpServers({
        config: {
          ai: {
            mcp: { servers: {} },
            stages: {
              "review-matrix": { mcp: { missing: { allow_tools: { model: ["search"] } } } },
            },
          },
        },
        stage: "review-matrix",
      }),
    ).toThrow("ai.stages.review-matrix.mcp.missing references an unknown MCP server.");

    expect(() =>
      stageMcpServers({
        config: {
          ai: {
            mcp: { servers: { dense_mem: { command: "node" } } },
            stages: {
              "review-matrix": {
                mcp: {
                  dense_mem: {
                    allow_tools: { context: ["recall"] },
                    context_calls: [{ tool: "search_memory" }],
                  },
                },
              },
            },
          },
        },
        stage: "review-matrix",
      }),
    ).toThrow(
      "ai.stages.review-matrix.mcp.dense_mem.context_calls includes tools not listed in allow_tools.context: search_memory.",
    );
  });
});

describe("MCP stage malformed field validation", () => {
  it("rejects malformed stage and server fields", () => {
    expect(() =>
      stageMcpServers({
        config: { ai: { stages: { "review-matrix": { mcp: [] } } } },
        stage: "review-matrix",
      }),
    ).toThrow("ai.stages.review-matrix.mcp must be an object.");

    expect(() =>
      stageMcpServers({
        config: {
          ai: {
            mcp: { servers: { "bad name": { command: "node" } } },
            stages: { "review-matrix": { mcp: { "bad name": {} } } },
          },
        },
        stage: "review-matrix",
      }),
    ).toThrow("ai.stages.review-matrix.mcp keys must be safe MCP server names.");

    expect(() =>
      stageMcpServers({
        config: {
          ai: {
            mcp: { servers: { dense_mem: { command: "node" } } },
            stages: {
              "review-matrix": {
                mcp: { dense_mem: { allow_tools: { model: ["bad tool"] } } },
              },
            },
          },
        },
        stage: "review-matrix",
      }),
    ).toThrow(
      "ai.stages.review-matrix.mcp.dense_mem.allow_tools.model values must be safe MCP tool names.",
    );

    expect(() =>
      stageMcpServers({
        config: {
          ai: {
            mcp: { servers: { dense_mem: { command: "node" } } },
            stages: { "review-matrix": { mcp: { dense_mem: { required: "yes" } } } },
          },
        },
        stage: "review-matrix",
      }),
    ).toThrow("ai.stages.review-matrix.mcp.dense_mem.required must be a boolean.");

    expect(() =>
      stageMcpServers({
        config: {
          ai: {
            mcp: { servers: { dense_mem: { command: "node" } } },
            stages: {
              "review-matrix": {
                mcp: {
                  dense_mem: {
                    allow_tools: { context: ["recall"] },
                    context_calls: [{ arguments: [], tool: "recall" }],
                  },
                },
              },
            },
          },
        },
        stage: "review-matrix",
      }),
    ).toThrow(
      "ai.stages.review-matrix.mcp.dense_mem.context_calls[0].arguments must be an object.",
    );
  });
});

describe("MCP stage tool field validation", () => {
  it("rejects malformed MCP tool lists and context calls", () => {
    expect(() =>
      stageMcpServers({
        config: denseMemConfig({ allow_tools: [] }),
        stage: "review-matrix",
      }),
    ).toThrow("ai.stages.review-matrix.mcp.dense_mem.allow_tools must be an object.");

    expect(() =>
      stageMcpServers({
        config: denseMemConfig({ allow_tools: { context: "recall" } }),
        stage: "review-matrix",
      }),
    ).toThrow("ai.stages.review-matrix.mcp.dense_mem.allow_tools.context must be a string array.");

    expect(() =>
      stageMcpServers({
        config: denseMemConfig({ context_calls: {} }),
        stage: "review-matrix",
      }),
    ).toThrow("ai.stages.review-matrix.mcp.dense_mem.context_calls must be an array.");

    expect(() =>
      stageMcpServers({
        config: denseMemConfig({ context_calls: [null] }),
        stage: "review-matrix",
      }),
    ).toThrow("ai.stages.review-matrix.mcp.dense_mem.context_calls[0] must be an object.");

    expect(() =>
      stageMcpServers({
        config: denseMemConfig({ context_calls: [{}] }),
        stage: "review-matrix",
      }),
    ).toThrow(
      "ai.stages.review-matrix.mcp.dense_mem.context_calls[0].tool must be a non-empty string.",
    );

    expect(() =>
      stageMcpServers({
        config: denseMemConfig({ context_calls: [{ tool: "bad tool" }] }),
        stage: "review-matrix",
      }),
    ).toThrow(
      "ai.stages.review-matrix.mcp.dense_mem.context_calls[0].tool values must be safe MCP tool names.",
    );
  });

  it("rejects malformed MCP server args", () => {
    expect(() =>
      stageMcpServers({
        config: denseMemConfig({}, { args: "server.js", command: "node" }),
        stage: "review-matrix",
      }),
    ).toThrow("ai.mcp.servers.dense_mem.args must be a string array.");

    expect(() =>
      stageMcpServers({
        config: denseMemConfig({}, { args: [""], command: "node" }),
        stage: "review-matrix",
      }),
    ).toThrow("ai.mcp.servers.dense_mem.args[0] must be a non-empty string.");
  });
});

describe("MCP stage credential validation", () => {
  it("rejects missing MCP bundle keys and env on HTTP servers", () => {
    expect(() =>
      stageMcpServers({
        config: mcpConfig(),
        env: { GITVIBE_MCP_ENV_JSON: JSON.stringify({ DOCS_TOKEN: "docs-token" }) },
        stage: "review-matrix",
      }),
    ).toThrow(
      "GITVIBE_MCP_ENV_JSON key DENSE_MEM_TOKEN is required by ai.mcp.servers.dense_mem.env.DENSE_MEM_TOKEN.from_bundle.",
    );

    expect(() =>
      stageMcpServers({
        config: {
          ai: {
            mcp: {
              servers: {
                docs: {
                  env: { TOKEN: { from_bundle: "DOCS_TOKEN" } },
                  transport: "http",
                  url: "https://mcp.example.test",
                },
              },
            },
            stages: {
              "review-matrix": { mcp: { docs: { allow_tools: { model: ["lookup"] } } } },
            },
          },
        },
        env: { GITVIBE_MCP_ENV_JSON: JSON.stringify({ DOCS_TOKEN: "docs-token" }) },
        stage: "review-matrix",
      }),
    ).toThrow("ai.mcp.servers.docs.env is supported only for stdio MCP servers.");
  });

  it("rejects invalid transport and credential source shapes", () => {
    expect(() =>
      stageMcpServers({
        config: {
          ai: {
            mcp: { servers: { docs: { transport: "websocket", url: "https://mcp.test" } } },
            stages: { "review-matrix": { mcp: { docs: { allow_tools: { model: ["lookup"] } } } } },
          },
        },
        stage: "review-matrix",
      }),
    ).toThrow("ai.mcp.servers.docs.transport must be stdio, http, or sse.");

    expect(() =>
      stageMcpServers({
        config: {
          ai: {
            mcp: { servers: { dense_mem: { command: "node", env: { "bad-name": "x" } } } },
            stages: { "review-matrix": { mcp: { dense_mem: {} } } },
          },
        },
        stage: "review-matrix",
      }),
    ).toThrow("ai.mcp.servers.dense_mem.env.bad-name must be a safe environment variable name.");

    expect(() =>
      stageMcpServers({
        config: {
          ai: {
            mcp: { servers: { dense_mem: { command: "node", env: { TOKEN: [] } } } },
            stages: { "review-matrix": { mcp: { dense_mem: {} } } },
          },
        },
        env: { GITVIBE_MCP_ENV_JSON: JSON.stringify({ TOKEN: "token" }) },
        stage: "review-matrix",
      }),
    ).toThrow("ai.mcp.servers.dense_mem.env.TOKEN must be an object with from_bundle.");

    expect(() =>
      stageMcpServers({
        config: {
          ai: {
            mcp: { servers: { dense_mem: { command: "node", env: { TOKEN: undefined } } } },
            stages: { "review-matrix": { mcp: { dense_mem: {} } } },
          },
        },
        stage: "review-matrix",
      }),
    ).toThrow("ai.mcp.servers.dense_mem.env.TOKEN must be a string or from_bundle source.");
  });
});

function mcpConfig() {
  return {
    ai: {
      mcp: {
        servers: {
          dense_mem: {
            args: ["server.js"],
            command: "node",
            env: {
              DENSE_MEM_TOKEN: { from_bundle: "DENSE_MEM_TOKEN" },
              LITERAL_VALUE: "literal",
            },
          },
          docs: {
            headers: { Authorization: { from_bundle: "DOCS_TOKEN" } },
            transport: "http",
            url: "https://mcp.example.test",
          },
        },
      },
      stages: {
        "review-matrix": {
          mcp: {
            dense_mem: {
              allow_tools: {
                context: ["recall"],
                model: ["search_memory"],
              },
              context_calls: [
                { arguments: { query: "{{repository}}#{{pr_number}}" }, tool: "recall" },
              ],
              required: false,
            },
            docs: {
              allow_tools: {
                model: ["lookup"],
              },
            },
          },
        },
      },
    },
  };
}

/**
 * @param {Record<string, unknown>} stageConfig
 * @param {Record<string, unknown>} [serverConfig]
 */
function denseMemConfig(stageConfig, serverConfig = undefined) {
  return {
    ai: {
      mcp: {
        servers: {
          dense_mem: serverConfig || { command: "node" },
        },
      },
      stages: {
        "review-matrix": {
          mcp: {
            dense_mem: stageConfig,
          },
        },
      },
    },
  };
}

/**
 * @returns {import("../src/shared/types.ts").ContextPacket}
 */
function contextPacket() {
  return {
    artifact: {
      body: "PR body",
      number: "42",
      title: "Review me",
      type: "pull-request",
      url: "https://github.com/owner/repo/pull/42",
    },
    generatedAt: "2026-06-04T00:00:00.000Z",
    repository: "owner/repo",
    timeline: [],
  };
}

/**
 * @returns {import("../src/shared/types.ts").RunnerOptions}
 */
function runnerOptions() {
  return {
    cwd: process.cwd(),
    dryRun: false,
    executionMode: "standard",
    issueNumber: "",
    maxTurns: 1,
    prNumber: "42",
    repository: "owner/repo",
    stage: "review-matrix",
    stageTimeoutMinutes: 10,
    token: "token",
  };
}
