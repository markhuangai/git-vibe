import { spawn } from "node:child_process";
import type { JsonObject } from "../shared/types.js";

interface CliCommandOptions {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
}

interface CliCommandResult {
  stderr: string;
  stdout: string;
}

export function commandParts(profile: Record<string, unknown>, fallback: string): string[] {
  const command = stringValue(profile.command) || fallback;
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error("AI profile command must not be empty.");
  return parts;
}

export function cliModelName(profile: Record<string, unknown>, adapter: string): string {
  return (
    stringValue(profile.model) || envValue(profile.model_variable, "GITVIBE_AI_MODEL", adapter)
  );
}

export function strictOutputSchema(schema: JsonObject): JsonObject {
  return normalizeSchemaValue(schema) as JsonObject;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function runStreamingCommand(options: CliCommandOptions): Promise<CliCommandResult> {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout?.on("data", (chunk: Buffer | string) => {
    const buffer = chunkBuffer(chunk);
    stdoutChunks.push(buffer);
    process.stdout.write(buffer);
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const buffer = chunkBuffer(chunk);
    stderrChunks.push(buffer);
    process.stderr.write(buffer);
  });
  child.stdin?.end(options.input);

  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, exitSignal) => {
      resolve({ code: exitCode, signal: exitSignal });
    });
  });
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");

  if (code !== 0) {
    throw new Error(
      `${options.command} failed with ${exitStatus(code, signal)}${errorSuffix(stderr)}`,
    );
  }

  return { stderr, stdout };
}

function normalizeSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeSchemaValue(item));
  if (!isRecord(value)) return value;

  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalizeSchemaValue(entry)]),
  );
  if (isRecord(normalized.properties)) {
    normalized.required = Object.keys(normalized.properties);
    normalized.additionalProperties ??= false;
  }
  return normalized;
}

function chunkBuffer(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function errorSuffix(stderr: string): string {
  const message = stderr.trim();
  return message ? `: ${message}` : "";
}

function exitStatus(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) return `exit code ${code}`;
  return signal ? `signal ${signal}` : "unknown exit status";
}

function envValue(variableName: unknown, fallbackName: string, adapter: string): string {
  const name = typeof variableName === "string" ? variableName : fallbackName;
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for ${adapter} profile`);
  }
  return value;
}
