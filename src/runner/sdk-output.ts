import type { JsonObject } from "../shared/types.js";
import { extractValidatedOutput } from "./ai-output.js";
import { validateOutput } from "./schemas.js";

export async function validatedSdkOutput(options: {
  content: string;
  schema: JsonObject;
  schemaId: string;
}): Promise<string> {
  const content = extractValidatedOutput({ text: options.content });
  await validateOutput({ content, schema: options.schema, schemaId: options.schemaId });
  return content;
}

export function structuredOutputText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim();
  return JSON.stringify(value);
}
