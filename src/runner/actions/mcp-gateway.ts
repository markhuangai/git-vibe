#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  connectMcpServer,
  mcpErrorResult,
  redactMcpText,
  safetyCheckedMcpResult,
} from "../mcp-client.js";
import type { ConnectedMcpServer } from "../mcp-client.js";
import type { ResolvedMcpServer } from "../mcp-config.js";
import { redactLogText } from "../logging.js";

interface GatewayConfig {
  allowTools: string[];
  required: boolean;
  server: ResolvedMcpServer;
}

interface GatewayRuntime {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string, encoding: BufferEncoding) => string;
  stderr?: (message: string) => void;
}

export async function runMcpGateway(runtime: GatewayRuntime = {}): Promise<number> {
  const env = runtime.env || process.env;
  const stderr = runtime.stderr || ((message) => process.stderr.write(redactLogText(message)));
  try {
    const config = gatewayConfig(env, runtime.readFile || readFileSync);
    await startGateway(config);
    return 0;
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export function isDirectRun(moduleUrl: string, entrypoint = process.argv[1]): boolean {
  const file = entrypoint ? basename(entrypoint) : "";
  if (!moduleUrl) return /^mcp-gateway\.(?:c?js|ts)$/.test(file);
  return Boolean(entrypoint && moduleUrl === pathToFileURL(resolve(entrypoint)).href);
}

export function exitOnGatewayFailure(
  code: number,
  exit: (code: number) => void = process.exit,
): void {
  if (code !== 0) exit(code);
}

async function startGateway(config: GatewayConfig): Promise<void> {
  const server = new Server(
    { name: `git-vibe-${config.server.name}-mcp-gateway`, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  let upstream: ConnectedMcpServer | undefined;
  const connection = async () => {
    upstream ??= await connectMcpServer({ server: config.server });
    return upstream;
  };

  server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => {
    try {
      const connected = await connection();
      const listed = await connected.client.listTools();
      return {
        ...listed,
        tools: listed.tools.filter((tool) => config.allowTools.includes(tool.name)),
      };
    } catch (error) {
      if (!config.required) return { tools: [] };
      throw new Error(
        `MCP gateway ${config.server.name} list tools failed: ${redactedMcpErrorMessage(
          error,
          config.server.secretValues,
        )}`,
      );
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = request.params.name;
    if (!config.allowTools.includes(tool)) {
      return mcpErrorResult(`Error [mcp-gateway]: tool is not allowed: ${tool}`);
    }
    const connected = await connection();
    try {
      const result = (await connected.client.callTool(request.params)) as CallToolResult;
      return safetyCheckedMcpResult({
        result,
        server: config.server.name,
        secretValues: config.server.secretValues,
        tool,
      });
    } catch (error) {
      return mcpErrorResult(
        `Error [mcp-gateway]: ${config.server.name}.${tool} failed: ${redactedMcpErrorMessage(
          error,
          config.server.secretValues,
        )}`,
      );
    }
  });

  process.once("exit", () => {
    void upstream?.close();
  });
  await server.connect(new StdioServerTransport());
}

function gatewayConfig(
  env: NodeJS.ProcessEnv,
  readFile: (path: string, encoding: BufferEncoding) => string,
): GatewayConfig {
  const path = env.GITVIBE_MCP_GATEWAY_CONFIG;
  if (!path) throw new Error("GITVIBE_MCP_GATEWAY_CONFIG is required.");
  const parsed = JSON.parse(readFile(path, "utf8")) as unknown;
  if (!isGatewayConfig(parsed)) {
    throw new Error("GITVIBE_MCP_GATEWAY_CONFIG must point to a valid gateway config.");
  }
  return parsed;
}

function redactedMcpErrorMessage(error: unknown, secretValues: string[]): string {
  return redactMcpText(error instanceof Error ? error.message : String(error), secretValues);
}

function isGatewayConfig(value: unknown): value is GatewayConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as GatewayConfig).allowTools) &&
    typeof (value as GatewayConfig).required === "boolean" &&
    typeof (value as GatewayConfig).server?.name === "string"
  );
}

if (isDirectRun("", process.argv[1])) {
  runMcpGateway().then((code) => exitOnGatewayFailure(code));
}
