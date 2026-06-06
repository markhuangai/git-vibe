import type {
  ContextPacket,
  GitVibeConfig,
  JsonObject,
  RunnerOptions,
  Stage,
} from "../shared/types.js";
import {
  bundleValueFromMcpSource,
  isRecord,
  sanitizedChildEnv,
  stringValue,
} from "./cli-adapter-utils.js";

export type McpTransportType = "http" | "sse" | "stdio";

export interface ResolvedMcpServer {
  args: string[];
  command?: string;
  env: NodeJS.ProcessEnv;
  headers: Record<string, string>;
  name: string;
  secretValues: string[];
  transport: McpTransportType;
  url?: string;
}

export interface ResolvedStageMcpServer {
  allowContextTools: string[];
  allowModelTools: string[];
  contextCalls: McpContextCall[];
  name: string;
  required: boolean;
  resolutionError?: string;
  server?: ResolvedMcpServer;
}

export interface McpContextCall {
  arguments: JsonObject;
  tool: string;
}

const safeNamePattern = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function stageMcpServers(options: {
  captureRequiredResolutionErrors?: boolean;
  config: GitVibeConfig;
  env?: NodeJS.ProcessEnv;
  stage: Stage;
}): ResolvedStageMcpServer[] {
  const stageEntries = stageMcpEntries(options.config, options.stage);
  if (Object.keys(stageEntries).length === 0) return [];

  const serverEntries = allServerEntries(options.config);
  return Object.entries(stageEntries).map(([name, stageValue]) => {
    validateName(name, `ai.stages.${options.stage}.mcp`);
    const serverValue = serverEntries[name];
    if (serverValue === undefined) {
      throw new Error(`ai.stages.${options.stage}.mcp.${name} references an unknown MCP server.`);
    }
    const stageServer = parseStageServerConfig(
      stageValue,
      `ai.stages.${options.stage}.mcp.${name}`,
    );
    try {
      return {
        ...stageServer,
        name,
        server: parseServerConfig(serverValue, `ai.mcp.servers.${name}`, name, options.env),
      };
    } catch (error) {
      if (stageServer.required && !options.captureRequiredResolutionErrors) throw error;
      return {
        ...stageServer,
        name,
        resolutionError: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export function modelMcpServersForStage(options: {
  config: GitVibeConfig;
  env?: NodeJS.ProcessEnv;
  stage: Stage;
}): ResolvedStageMcpServer[] {
  return stageMcpServers(options).filter((entry) => entry.allowModelTools.length > 0);
}

export function renderMcpTemplateValue(
  value: unknown,
  context: ContextPacket,
  runner: RunnerOptions,
): unknown {
  if (typeof value === "string") return renderMcpTemplateString(value, context, runner);
  if (Array.isArray(value))
    return value.map((item) => renderMcpTemplateValue(item, context, runner));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      renderMcpTemplateValue(entry, context, runner),
    ]),
  );
}

function stageMcpEntries(config: GitVibeConfig, stage: Stage): Record<string, unknown> {
  const stages = config.ai?.stages;
  if (!isRecord(stages)) return {};
  const stageConfig = stages[stage];
  if (!isRecord(stageConfig)) return {};
  const mcp = stageConfig.mcp;
  if (mcp === undefined) return {};
  if (!isRecord(mcp)) throw new Error(`ai.stages.${stage}.mcp must be an object.`);
  return mcp;
}

function allServerEntries(config: GitVibeConfig): Record<string, unknown> {
  const mcp = config.ai?.mcp;
  if (!isRecord(mcp)) throw new Error("ai.mcp must be an object when stages reference MCP.");
  const servers = mcp.servers;
  if (!isRecord(servers)) throw new Error("ai.mcp.servers must be an object.");
  return servers;
}

function parseStageServerConfig(
  value: unknown,
  path: string,
): Omit<ResolvedStageMcpServer, "name" | "resolutionError" | "server"> {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  const required =
    value.required === undefined ? true : booleanValue(value.required, `${path}.required`);
  const tools = uniqueToolNames(stringArray(value.tools, `${path}.tools`, false), `${path}.tools`);
  const allowTools = allowToolsConfig(value.allow_tools, `${path}.allow_tools`);
  const contextCalls = contextCallsConfig(value.context_calls, `${path}.context_calls`);
  const contextTools = uniqueToolNames([...tools, ...allowTools.context], `${path}.tools`);
  const modelTools = uniqueToolNames([...tools, ...allowTools.model], `${path}.tools`);
  const disallowedContextCalls = contextCalls
    .map((call) => call.tool)
    .filter((tool) => !contextTools.includes(tool));
  if (disallowedContextCalls.length > 0) {
    throw new Error(
      `${path}.context_calls includes tools not listed in tools or allow_tools.context: ${[
        ...new Set(disallowedContextCalls),
      ].join(", ")}.`,
    );
  }
  return {
    allowContextTools: contextTools,
    allowModelTools: modelTools,
    contextCalls,
    required,
  };
}

function parseServerConfig(
  value: unknown,
  path: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedMcpServer {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  const transport = transportType(value.transport, path);
  const args = stringArray(value.args, `${path}.args`, false);
  const resolvedEnv = resolvedStringMap(value.env, `${path}.env`, env);
  const headers = resolvedStringMap(value.headers, `${path}.headers`, env);
  if (transport === "stdio") {
    const command = stringValue(value.command);
    if (!command) throw new Error(`${path}.command must be configured for stdio MCP servers.`);
    return {
      args,
      command,
      env: { ...sanitizedChildEnv(env), ...resolvedEnv.values },
      headers: {},
      name,
      secretValues: resolvedEnv.secretValues,
      transport,
    };
  }
  const url = stringValue(value.url);
  if (!url) throw new Error(`${path}.url must be configured for ${transport} MCP servers.`);
  if (Object.keys(resolvedEnv.values).length > 0) {
    throw new Error(`${path}.env is supported only for stdio MCP servers.`);
  }
  return {
    args: [],
    env: sanitizedChildEnv(env),
    headers: headers.values,
    name,
    secretValues: headers.secretValues,
    transport,
    url,
  };
}

function allowToolsConfig(value: unknown, path: string): { context: string[]; model: string[] } {
  if (value === undefined) return { context: [], model: [] };
  if (Array.isArray(value))
    return {
      context: [],
      model: uniqueToolNames(stringArray(value, path, true), path),
    };
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  return {
    context: uniqueToolNames(
      stringArray(value.context, `${path}.context`, false),
      `${path}.context`,
    ),
    model: uniqueToolNames(stringArray(value.model, `${path}.model`, false), `${path}.model`),
  };
}

function contextCallsConfig(value: unknown, path: string): McpContextCall[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry)) throw new Error(`${entryPath} must be an object.`);
    const tool = stringValue(entry.tool);
    if (!tool) throw new Error(`${entryPath}.tool must be a non-empty string.`);
    validateToolName(tool, `${entryPath}.tool`);
    const args = entry.arguments;
    if (args !== undefined && !isRecord(args))
      throw new Error(`${entryPath}.arguments must be an object.`);
    return { arguments: (args || {}) as JsonObject, tool };
  });
}

function resolvedStringMap(
  value: unknown,
  path: string,
  env: NodeJS.ProcessEnv,
): { secretValues: string[]; values: Record<string, string> } {
  if (value === undefined) return { secretValues: [], values: {} };
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  const secretValues: string[] = [];
  const values = Object.fromEntries(
    Object.entries(value).map(([key, source]) => {
      validateEnvName(key, `${path}.${key}`);
      const resolved =
        typeof source === "string"
          ? source
          : bundleValueFromMcpSource(source, `${path}.${key}`, env);
      if (resolved === undefined)
        throw new Error(`${path}.${key} must be a string or from_bundle source.`);
      if (typeof source !== "string") secretValues.push(resolved);
      return [key, resolved];
    }),
  );
  return { secretValues, values };
}

function transportType(value: unknown, path: string): McpTransportType {
  const transport = stringValue(value) || "stdio";
  if (transport === "stdio" || transport === "http" || transport === "sse") return transport;
  throw new Error(`${path}.transport must be stdio, http, or sse.`);
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
  return value;
}

function stringArray(value: unknown, path: string, required: boolean): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) throw new Error(`${path} must be a string array.`);
  return value.map((entry, index) => {
    const result = stringValue(entry);
    if (!result) throw new Error(`${path}[${index}] must be a non-empty string.`);
    return result;
  });
}

function uniqueToolNames(values: string[], path: string): string[] {
  for (const value of values) validateToolName(value, path);
  return [...new Set(values)];
}

function validateName(value: string, path: string): void {
  if (!safeNamePattern.test(value)) {
    throw new Error(`${path} keys must be safe MCP server names.`);
  }
}

function validateToolName(value: string, path: string): void {
  if (!safeNamePattern.test(value)) {
    throw new Error(`${path} values must be safe MCP tool names.`);
  }
}

function validateEnvName(value: string, path: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${path} must be a safe environment variable name.`);
  }
}

function renderMcpTemplateString(
  value: string,
  context: ContextPacket,
  runner: RunnerOptions,
): string {
  const replacements: Record<string, string> = {
    artifact_number: context.artifact.number,
    artifact_title: context.artifact.title,
    artifact_type: context.artifact.type,
    issue_number: runner.issueNumber || "",
    pr_number: runner.prNumber || "",
    repository: context.repository,
    stage: runner.stage,
  };
  return value.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (match, key: string) =>
    Object.hasOwn(replacements, key) ? replacements[key] : match,
  );
}
