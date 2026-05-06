import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createOutputValidator } from "agentool/output-validator";
import type { JsonObject } from "./types.js";

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
  const rawText = String(rawResult);
  if (!rawText.trim().startsWith("{")) {
    throw new Error(`agentool output-validator returned a non-JSON result: ${rawText}`);
  }

  const result = JSON.parse(rawText) as {
    errors?: Array<{ message?: string; path?: string }>;
    valid?: boolean;
  };

  if (!result.valid) {
    const errors =
      result.errors?.map((error) => `${error.path || "/"} ${error.message || ""}`) || [];
    throw new Error(`AI output failed ${options.schemaId} validation: ${errors.join("; ")}`);
  }

  return JSON.parse(options.content) as JsonObject;
}

function assetRoot(): string {
  return (
    process.env.GITVIBE_ASSET_ROOT ||
    (process.env.GITHUB_ACTION_PATH ? dirname(process.env.GITHUB_ACTION_PATH) : process.cwd())
  );
}
