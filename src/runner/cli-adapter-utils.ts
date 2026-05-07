import type { JsonObject } from "../shared/types.js";

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

function envValue(variableName: unknown, fallbackName: string, adapter: string): string {
  const name = typeof variableName === "string" ? variableName : fallbackName;
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for ${adapter} profile`);
  }
  return value;
}
