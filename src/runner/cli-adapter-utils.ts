import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import type { JsonObject } from "../shared/types.js";
import { redactLogText } from "./logging.js";

interface CliCommandOptions {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  stdoutFile?: string;
  stdoutFlush?: () => void;
  stdoutLog?: (text: string) => void;
}

interface CliCommandResult {
  stderr: string;
  stdout: string;
}

export const aiEnvBundleVariable = "GITVIBE_AI_ENV_JSON";

export function cliModelName(profile: Record<string, unknown>, adapter: string): string {
  const model = stringValue(profile.model);
  if (!model) throw new Error(`AI profile model must be configured for ${adapter} profile.`);
  return model;
}

export function strictOutputSchema(schema: JsonObject): JsonObject {
  return normalizeSchemaValue(schema) as JsonObject;
}

export function codexOutputSchema(schema: JsonObject): JsonObject {
  return normalizeSchemaValue(schema, { omitKeys: new Set(["allOf"]) }) as JsonObject;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cliProfileEnv(
  profile: Record<string, unknown>,
  profilePath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = sanitizedChildEnv(baseEnv);

  const profileEnv = profile.env;
  if (profileEnv === undefined) return env;
  if (!isRecord(profileEnv)) throw new Error(`${profilePath}.env must be an object.`);

  let bundle: Record<string, string> | undefined;
  for (const [target, source] of Object.entries(profileEnv)) {
    if (!target.trim()) throw new Error(`${profilePath}.env keys must be non-empty strings.`);
    env[target] = profileEnvValue(source, `${profilePath}.env.${target}`, () => {
      bundle ??= parseRequiredAiEnvBundle(baseEnv, `${profilePath}.env`);
      return bundle;
    });
  }

  return env;
}

export function sanitizedChildEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  for (const name of Object.keys(env)) {
    if (name === aiEnvBundleVariable || legacyAiEnvNames.has(name) || sensitiveEnvName(name)) {
      delete env[name];
    }
  }
  return env;
}

export function bundleValueFromSource(
  source: unknown,
  sourcePath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (source === undefined) return undefined;
  const bundle = parseRequiredAiEnvBundle(baseEnv, sourcePath);
  return bundleValue(source, sourcePath, bundle);
}

export function bundleKeyFromSource(source: unknown, sourcePath: string): string | undefined {
  if (source === undefined) return undefined;
  if (!isRecord(source)) throw new Error(`${sourcePath} must be an object with from_bundle.`);
  const key = stringValue(source.from_bundle);
  if (!key) throw new Error(`${sourcePath}.from_bundle must be a non-empty string.`);
  return key;
}

export function optionalAiEnvBundleSecretValues(
  baseEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = baseEnv[aiEnvBundleVariable];
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return [];
    return Object.values(parsed).filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

export async function runStreamingCommand(options: CliCommandOptions): Promise<CliCommandResult> {
  if (options.stdoutFile) writeFileSync(options.stdoutFile, "");

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
    if (options.stdoutFile) appendFileSync(options.stdoutFile, buffer);
    const text = buffer.toString("utf8");
    if (options.stdoutLog) options.stdoutLog(text);
    else process.stdout.write(redactLogText(text));
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const buffer = chunkBuffer(chunk);
    stderrChunks.push(buffer);
    process.stderr.write(redactLogText(buffer.toString("utf8")));
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
  options.stdoutFlush?.();
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");

  if (code !== 0) {
    throw new Error(
      `${options.command} failed with ${exitStatus(code, signal)}${errorSuffix(stderr)}`,
    );
  }

  return { stderr, stdout };
}

function normalizeSchemaValue(value: unknown, options: { omitKeys?: Set<string> } = {}): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeSchemaValue(item, options));
  if (!isRecord(value)) return value;

  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (options.omitKeys?.has(key)) continue;
    normalized[key] = normalizeSchemaValue(entry, options);
  }
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
  const message = redactLogText(stderr.trim());
  return message ? `: ${message}` : "";
}

function exitStatus(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) return `exit code ${code}`;
  return signal ? `signal ${signal}` : "unknown exit status";
}

export function parseRequiredAiEnvBundle(
  baseEnv: NodeJS.ProcessEnv,
  requiredBy: string,
): Record<string, string> {
  const raw = baseEnv[aiEnvBundleVariable];
  if (!raw) throw new Error(`${aiEnvBundleVariable} is required by ${requiredBy}.`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${aiEnvBundleVariable} must be valid JSON: ${String(error)}.`);
  }

  if (!isRecord(parsed)) throw new Error(`${aiEnvBundleVariable} must be a JSON object.`);
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error(`${aiEnvBundleVariable}.${key} must be a string.`);
    }
  }
  return parsed as Record<string, string>;
}

const legacyAiEnvNames = new Set(["GITVIBE_AI_BASE_URL"]);

function bundleValue(source: unknown, sourcePath: string, bundle: Record<string, string>): string {
  if (!isRecord(source)) throw new Error(`${sourcePath} must be an object with from_bundle.`);
  const key = stringValue(source.from_bundle);
  if (!key) throw new Error(`${sourcePath}.from_bundle must be a non-empty string.`);
  if (!(key in bundle)) {
    throw new Error(`GITVIBE_AI_ENV_JSON key ${key} is required by ${sourcePath}.from_bundle.`);
  }
  return bundle[key];
}

function profileEnvValue(
  source: unknown,
  sourcePath: string,
  bundle: () => Record<string, string>,
): string {
  if (typeof source === "string") return source;
  return bundleValue(source, sourcePath, bundle());
}

function sensitiveEnvName(name: string): boolean {
  return /(AUTH|AUTHORIZATION|CREDENTIALS?|KEY|PASSWORD|SECRET|TOKEN)/i.test(name);
}
