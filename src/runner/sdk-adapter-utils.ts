import type { JsonObject } from "../shared/types.js";

export const aiEnvBundleVariable = "GITVIBE_AI_ENV_JSON";
export const mcpEnvBundleVariable = "GITVIBE_MCP_ENV_JSON";

export function sdkModelName(profile: Record<string, unknown>, adapter: string): string {
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

export function sdkProfileEnv(
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
    if (
      name === aiEnvBundleVariable ||
      name === mcpEnvBundleVariable ||
      legacyAiEnvNames.has(name) ||
      sensitiveEnvName(name)
    ) {
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

export function optionalAiEnvBundleSecretValues(
  baseEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  return optionalEnvBundleSecretValues(aiEnvBundleVariable, baseEnv);
}

export function optionalMcpEnvBundleSecretValues(
  baseEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  return optionalEnvBundleSecretValues(mcpEnvBundleVariable, baseEnv);
}

function optionalEnvBundleSecretValues(
  variable: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = baseEnv[variable];
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return [];
    return Object.values(parsed).filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
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

export function parseRequiredAiEnvBundle(
  baseEnv: NodeJS.ProcessEnv,
  requiredBy: string,
): Record<string, string> {
  return parseRequiredEnvBundle(aiEnvBundleVariable, baseEnv, requiredBy);
}

export function parseRequiredMcpEnvBundle(
  baseEnv: NodeJS.ProcessEnv,
  requiredBy: string,
): Record<string, string> {
  return parseRequiredEnvBundle(mcpEnvBundleVariable, baseEnv, requiredBy);
}

export function bundleValueFromMcpSource(
  source: unknown,
  sourcePath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (source === undefined) return undefined;
  const bundle = parseRequiredMcpEnvBundle(baseEnv, sourcePath);
  return bundleValueForVariable(source, sourcePath, bundle, mcpEnvBundleVariable);
}

function parseRequiredEnvBundle(
  variable: string,
  baseEnv: NodeJS.ProcessEnv,
  requiredBy: string,
): Record<string, string> {
  const raw = baseEnv[variable];
  if (!raw) throw new Error(`${variable} is required by ${requiredBy}.`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${variable} must be valid JSON: ${String(error)}.`);
  }

  if (!isRecord(parsed)) throw new Error(`${variable} must be a JSON object.`);
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error(`${variable}.${key} must be a string.`);
    }
  }
  return parsed as Record<string, string>;
}

// Strip retired local-proxy bundle keys if older workflows still export them.
const legacyAiEnvNames = new Set(["GITVIBE_AI_BASE_URL"]);

function bundleValue(source: unknown, sourcePath: string, bundle: Record<string, string>): string {
  return bundleValueForVariable(source, sourcePath, bundle, aiEnvBundleVariable);
}

function bundleValueForVariable(
  source: unknown,
  sourcePath: string,
  bundle: Record<string, string>,
  variable: string,
): string {
  if (!isRecord(source)) throw new Error(`${sourcePath} must be an object with from_bundle.`);
  const key = stringValue(source.from_bundle);
  if (!key) throw new Error(`${sourcePath}.from_bundle must be a non-empty string.`);
  if (!(key in bundle)) {
    throw new Error(`${variable} key ${key} is required by ${sourcePath}.from_bundle.`);
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
