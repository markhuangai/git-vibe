import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunAiStageOptions } from "./ai.js";
import { modelMcpServersForStage } from "./mcp-config.js";
import { namespacedToolName } from "./mcp-ai-tools.js";

export interface CliMcpConfig {
  claudeArgs: string[];
  codexConfigArgs: string[];
}

interface GatewayFile {
  path: string;
  serverName: string;
  tools: string[];
}

export function prepareCliMcpConfig(options: {
  contextDir: string;
  options: RunAiStageOptions;
}): CliMcpConfig {
  const stageServers = modelMcpServersForStage({
    config: options.options.config,
    stage: options.options.stage,
  });
  if (stageServers.length === 0) return { claudeArgs: [], codexConfigArgs: [] };

  const gatewayDir = join(options.contextDir, "mcp-gateway");
  mkdirSync(gatewayDir, { recursive: true });
  const files = stageServers.flatMap((stageServer) => {
    if (!stageServer.server) {
      options.options.logger?.event("mcp.cli_config.warning", {
        reason: stageServer.resolutionError,
        server: stageServer.name,
      });
      return [];
    }
    const path = join(gatewayDir, `${stageServer.server.name}.json`);
    writeFileSync(
      path,
      JSON.stringify(
        {
          allowTools: stageServer.allowModelTools,
          required: stageServer.required,
          server: stageServer.server,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    return [{ path, serverName: stageServer.server.name, tools: stageServer.allowModelTools }];
  });
  if (files.length === 0) return { claudeArgs: [], codexConfigArgs: [] };

  options.options.logger?.event("mcp.cli_config.ready", {
    servers: files.map((file) => file.serverName).join(","),
  });
  return {
    claudeArgs: claudeMcpArgs(files),
    codexConfigArgs: codexMcpConfigArgs(files),
  };
}

function codexMcpConfigArgs(files: GatewayFile[]): string[] {
  return files.flatMap((file) => {
    const prefix = `mcp_servers.${file.serverName}`;
    const args = [gatewayScriptPath()];
    return [
      "-c",
      `${prefix}.enabled=true`,
      "-c",
      `${prefix}.command=${JSON.stringify(process.execPath)}`,
      "-c",
      `${prefix}.args=${tomlStringArray(args)}`,
      "-c",
      `${prefix}.env.GITVIBE_MCP_GATEWAY_CONFIG=${JSON.stringify(file.path)}`,
      ...file.tools.flatMap((tool) => [
        "-c",
        `${prefix}.tools.${tool}.approval_mode=${JSON.stringify("approve")}`,
      ]),
    ];
  });
}

function claudeMcpArgs(files: GatewayFile[]): string[] {
  const mcpServers = Object.fromEntries(
    files.map((file) => [
      file.serverName,
      {
        args: [gatewayScriptPath()],
        command: process.execPath,
        env: { GITVIBE_MCP_GATEWAY_CONFIG: file.path },
      },
    ]),
  );
  const allowedTools = files.flatMap((file) =>
    file.tools.map((tool) => namespacedToolName(file.serverName, tool)),
  );
  return [
    "--mcp-config",
    JSON.stringify({ mcpServers }),
    "--strict-mcp-config",
    "--allowedTools",
    allowedTools.join(","),
  ];
}

function gatewayScriptPath(): string {
  const actionPath = process.env.GITHUB_ACTION_PATH;
  if (actionPath) return resolve(actionPath, "..", "dist", "actions", "mcp-gateway.js");
  return resolve(process.cwd(), "dist", "actions", "mcp-gateway.js");
}

function tomlStringArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}
