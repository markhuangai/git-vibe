import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Ajv, type ErrorObject } from "ajv";
import type { JsonObject } from "../shared/types.js";

export function loadStageSchema(schemaFile: string): JsonObject {
  return JSON.parse(
    readFileSync(join(assetRoot(), "schemas", "stages", schemaFile), "utf8"),
  ) as JsonObject;
}

export async function validateOutput(options: {
  content: string;
  schema: JsonObject;
  schemaId: string;
}): Promise<JsonObject> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(options.content) as unknown;
  } catch (error) {
    throw new Error(
      `AI output failed ${options.schemaId} validation: invalid JSON: ${errorMessage(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(
      `AI output failed ${options.schemaId} validation: output must be a JSON object`,
    );
  }

  const validator = ajv().compile(options.schema);
  if (!validator(parsed)) {
    throw new Error(
      `AI output failed ${options.schemaId} validation: ${validationErrorSummary(
        validator.errors,
      )}`,
    );
  }

  return parsed as JsonObject;
}

function ajv(): Ajv {
  return new Ajv({ allErrors: true, strict: false });
}

function validationErrorSummary(errors: ErrorObject[] | null | undefined): string {
  const messages = errors?.map(validationErrorText).filter(Boolean) || [];
  if (messages.length > 0) return messages.join("; ");
  return "unknown validation error";
}

function validationErrorText(error: ErrorObject): string {
  const path = error.instancePath || "/";
  const message = error.message || "failed validation";
  const keyword = error.keyword ? ` [${error.keyword}]` : "";
  return `${path} ${message}${keyword}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assetRoot(): string {
  return (
    process.env.GITVIBE_ASSET_ROOT ||
    (process.env.GITHUB_ACTION_PATH ? dirname(process.env.GITHUB_ACTION_PATH) : process.cwd())
  );
}
