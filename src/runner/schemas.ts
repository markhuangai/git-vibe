import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createOutputValidator } from "agentool/output-validator";
import type { OutputValidationResult } from "agentool/output-validator";
import type { JsonObject } from "../shared/types.js";

type AgentoolValidationError = NonNullable<OutputValidationResult["errors"]>[number];
type LenientOutputValidationResult = Partial<Omit<OutputValidationResult, "errors">> & {
  errors?: Array<Partial<AgentoolValidationError>>;
};

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
  const validator = createOutputValidator({
    errorMode: "all",
    schema: options.schema as never,
    schemaId: options.schemaId,
  });
  if (!validator.execute) {
    throw new Error("agentool output validator is missing an execute function");
  }

  const rawResult = await validator.execute(
    { content: options.content },
    { messages: [], toolCallId: "git-vibe-deterministic-validation" },
  );
  const result = parseOutputValidationResult(rawResult);

  if (!result.valid) {
    throw new Error(
      `AI output failed ${options.schemaId} validation: ${validationErrorSummary(result)}`,
    );
  }

  return JSON.parse(options.content) as JsonObject;
}

function parseOutputValidationResult(raw: unknown): LenientOutputValidationResult {
  const parsed = outputValidationValue(raw);
  if (!isRecord(parsed)) {
    throw new Error(
      `agentool output-validator returned a malformed result: ${boundedText(String(parsed))}`,
    );
  }
  return parsed as LenientOutputValidationResult;
}

function outputValidationValue(raw: unknown): unknown {
  if (isRecord(raw) && "valid" in raw) return raw;
  const text = outputValidationText(raw);
  if (text !== undefined) return parseOutputValidationText(text);
  if (isRecord(raw)) return raw;
  throw new Error(
    `agentool output-validator returned a malformed result: ${boundedText(String(raw))}`,
  );
}

function outputValidationText(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return textParts(raw);
  if (!isRecord(raw)) return undefined;

  for (const key of ["content", "text", "result", "output"]) {
    const value = raw[key];
    const text = outputValidationText(value);
    if (text !== undefined) return text;
  }
  return undefined;
}

function textParts(parts: unknown[]): string | undefined {
  const text = parts
    .map((part) => {
      if (typeof part === "string") return part;
      if (isRecord(part) && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
  return text || undefined;
}

function parseOutputValidationText(text: string): LenientOutputValidationResult {
  const jsonText = firstJsonObject(text);
  if (!jsonText) {
    throw new Error(
      `agentool output-validator returned an unparseable result: ${boundedText(text)}`,
    );
  }
  try {
    return JSON.parse(jsonText) as LenientOutputValidationResult;
  } catch (error) {
    throw new Error(
      `agentool output-validator returned invalid JSON: ${errorMessage(error)} (${boundedText(text)})`,
    );
  }
}

function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;

  let depth = 0;
  let escaped = false;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') inString = true;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function validationErrorSummary(result: LenientOutputValidationResult): string {
  const errors = result.errors?.map(validationErrorText).filter(Boolean) || [];
  if (errors.length > 0) return errors.join("; ");
  if (result.message?.trim()) return result.message.trim();
  return "unknown validation error";
}

function validationErrorText(error: {
  keyword?: unknown;
  message?: unknown;
  path?: unknown;
}): string {
  const path = typeof error.path === "string" && error.path ? error.path : "/";
  const message =
    typeof error.message === "string" && error.message ? error.message : "failed validation";
  const keyword = typeof error.keyword === "string" && error.keyword ? ` [${error.keyword}]` : "";
  return `${path} ${message}${keyword}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedText(text: string): string {
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function assetRoot(): string {
  return (
    process.env.GITVIBE_ASSET_ROOT ||
    (process.env.GITHUB_ACTION_PATH ? dirname(process.env.GITHUB_ACTION_PATH) : process.cwd())
  );
}
