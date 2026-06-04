import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ResolvedMcpServer } from "./mcp-config.js";
import type { StageLogger } from "./logging.js";
import { redactLogText } from "./logging.js";
import { safetyFindingsForText } from "./safety-gate.js";

export interface ConnectedMcpServer {
  client: Client;
  close: () => Promise<void>;
  server: ResolvedMcpServer;
}

const maxMcpResultScanChars = 100_000;

export async function connectMcpServer(options: {
  logger?: StageLogger;
  server: ResolvedMcpServer;
}): Promise<ConnectedMcpServer> {
  const transport = transportForServer(options.server, options.logger);
  const client = new Client({ name: "git-vibe", version: "1.0.0" });
  await client.connect(transport);
  options.logger?.event("mcp.connect.done", {
    server: options.server.name,
    transport: options.server.transport,
  });
  return {
    client,
    close: () => client.close(),
    server: options.server,
  };
}

export async function listMcpTools(connection: ConnectedMcpServer): Promise<ListToolsResult> {
  return connection.client.listTools();
}

export async function callMcpTool(options: {
  arguments: Record<string, unknown>;
  connection: ConnectedMcpServer;
  logger?: StageLogger;
  tool: string;
}): Promise<CallToolResult> {
  const result = (await options.connection.client.callTool(
    {
      arguments: options.arguments,
      name: options.tool,
    },
    CallToolResultSchema,
  )) as CallToolResult;
  return safetyCheckedMcpResult({
    logger: options.logger,
    result,
    server: options.connection.server.name,
    secretValues: options.connection.server.secretValues,
    tool: options.tool,
  });
}

export function safetyCheckedMcpResult(options: {
  logger?: StageLogger;
  result: CallToolResult;
  server: string;
  secretValues?: string[];
  tool: string;
}): CallToolResult {
  const result = redactMcpResultSecrets(options.result, options.secretValues || []);
  const text = mcpResultText(result);
  const scanText =
    text.length > maxMcpResultScanChars ? text.slice(0, maxMcpResultScanChars) : text;
  const safety = safetyFindingsForText({
    label: `MCP ${options.server}.${options.tool} result`,
    text: scanText,
  });
  options.logger?.event("mcp.tool.safety.checked", {
    findings: safety.findings.length,
    server: options.server,
    severity: safety.severity,
    tool: options.tool,
  });
  if (safety.severity !== "high") return result;
  return {
    content: [
      {
        text: [
          `Error [mcp:${options.server}.${options.tool}]: high-risk prompt-injection content detected in MCP tool result.`,
          "",
          "Detected risk:",
          ...safety.findings.map((finding) => `- ${finding}`),
        ].join("\n"),
        type: "text",
      },
    ],
    isError: true,
  };
}

export function mcpResultText(result: CallToolResult): string {
  const parts: string[] = [];
  for (const item of result.content || []) {
    if (item.type === "text") parts.push(item.text);
    if (item.type === "resource" && "text" in item.resource) parts.push(item.resource.text);
    if (item.type === "resource_link") {
      parts.push([item.uri, item.name, item.description].filter(Boolean).join(" "));
    }
  }
  if (result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  return parts.join("\n");
}

export function mcpErrorResult(message: string): CallToolResult {
  return { content: [{ text: message, type: "text" }], isError: true };
}

export function redactMcpText(value: string, secretValues: string[]): string {
  return activeMcpSecrets(secretValues).reduce(
    (text, secret) => text.split(secret).join("<redacted:mcp-secret>"),
    value,
  );
}

function redactMcpResultSecrets(result: CallToolResult, secretValues: string[]): CallToolResult {
  const secrets = activeMcpSecrets(secretValues);
  if (secrets.length === 0) return result;
  return {
    ...result,
    content: result.content?.map((item) => redactMcpContentItem(item, secrets)) || [],
    structuredContent:
      result.structuredContent === undefined
        ? undefined
        : redactMcpJsonValue(result.structuredContent, secrets),
  } as CallToolResult;
}

function redactMcpContentItem(item: CallToolResult["content"][number], secrets: string[]) {
  if (item.type === "text") return { ...item, text: redactMcpText(item.text, secrets) };
  if (item.type === "resource" && "text" in item.resource) {
    return {
      ...item,
      resource: { ...item.resource, text: redactMcpText(item.resource.text, secrets) },
    };
  }
  return redactMcpJsonValue(item, secrets) as CallToolResult["content"][number];
}

function redactMcpJsonValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactMcpText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactMcpJsonValue(item, secrets));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactMcpJsonValue(entry, secrets)]),
  );
}

function activeMcpSecrets(secretValues: string[]): string[] {
  return [...new Set(secretValues.filter((value) => value.length >= 4))];
}

function transportForServer(server: ResolvedMcpServer, logger: StageLogger | undefined): Transport {
  if (server.transport === "stdio") {
    const transport = new StdioClientTransport({
      args: server.args,
      command: server.command || "",
      env: server.env as Record<string, string>,
      stderr: "pipe",
    });
    const stderr = transport.stderr;
    stderr?.on("data", (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      logger?.raw?.(redactLogText(text));
    });
    return transport;
  }

  const requestInit = Object.keys(server.headers).length > 0 ? { headers: server.headers } : {};
  if (server.transport === "sse") {
    return new SSEClientTransport(new URL(requiredUrl(server)), {
      requestInit,
    });
  }
  return new StreamableHTTPClientTransport(new URL(requiredUrl(server)), {
    requestInit,
  });
}

function requiredUrl(server: ResolvedMcpServer): string {
  if (!server.url) throw new Error(`MCP server ${server.name} requires a URL.`);
  return server.url;
}
