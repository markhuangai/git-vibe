import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StageDefinition } from "../shared/types.js";
import type { RunAiStageOptions } from "./ai.js";

export function runCodexCliStage({
  options,
  profile,
  profileName,
  tools,
}: {
  options: RunAiStageOptions;
  profile: Record<string, unknown>;
  profileName: string;
  tools: string[];
}): string {
  const contextDir = mkdtempSync(join(tmpdir(), "git-vibe-codex-"));
  const schemaFile = join(contextDir, `${options.stage}.schema.json`);
  const outputFile = join(contextDir, `${options.stage}.output.json`);
  writeFileSync(schemaFile, JSON.stringify(options.schema, null, 2));

  const [command, ...configuredArgs] = commandParts(profile, "codex exec");
  const model = cliModelName(profile);
  const args = [
    ...configuredArgs,
    "--cd",
    options.cwd,
    "--model",
    model,
    "--output-schema",
    schemaFile,
    "--output-last-message",
    outputFile,
    "--sandbox",
    codexSandbox(options.stageDefinition.access),
    ...codexReasoningArgs(profile),
  ];
  options.logger?.event("ai.request.start", {
    adapter: "cli-codex",
    max_turns: options.maxTurns,
    model,
    profile: profileName,
    provider: "cli-codex",
    tools: tools.join(","),
  });

  const output = execFileSync(command, args, {
    cwd: options.cwd,
    env: codexEnv(profile, contextDir),
    input: cliPrompt(options),
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  options.logger?.event("ai.request.done", {
    adapter: "cli-codex",
    output_chars: output.toString("utf8").length,
    profile: profileName,
  });

  return readFileSync(outputFile, "utf8").trim();
}

function commandParts(profile: Record<string, unknown>, fallback: string): string[] {
  const command = stringValue(profile.command) || fallback;
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error("AI profile command must not be empty.");
  return parts;
}

function cliModelName(profile: Record<string, unknown>): string {
  return stringValue(profile.model) || envValue(profile.model_variable, "GITVIBE_AI_MODEL");
}

function codexReasoningArgs(profile: Record<string, unknown>): string[] {
  const reasoning = profile.reasoning as Record<string, unknown> | undefined;
  const args: string[] = [];
  const effort = stringValue(reasoning?.effort);
  const summary = stringValue(reasoning?.summary);
  if (effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
  if (summary) args.push("-c", `model_reasoning_summary=${JSON.stringify(summary)}`);
  return args;
}

function codexEnv(profile: Record<string, unknown>, contextDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const authSecret = stringValue(profile.auth_json_secret);
  const authJson = authSecret ? process.env[authSecret] : undefined;
  if (authJson) {
    const codexHome = join(contextDir, "codex-home");
    env.CODEX_HOME = codexHome;
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "auth.json"), authJson);
  }
  return env;
}

function codexSandbox(access: StageDefinition["access"]): string {
  return access === "branch-write" ? "workspace-write" : "read-only";
}

function cliPrompt(options: RunAiStageOptions): string {
  return `${options.system}\n\n${options.prompt}`;
}

function envValue(variableName: unknown, fallbackName: string, fallbackValue?: string): string {
  const name = typeof variableName === "string" ? variableName : fallbackName;
  const value = process.env[name] || fallbackValue;
  if (!value) {
    throw new Error(`${name} is required for cli-codex profile`);
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
