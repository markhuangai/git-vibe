import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContextPacket, JsonObject } from "../shared/types.js";

export interface RenderPromptOptions {
  context: ContextPacket;
  outputSchema: JsonObject;
  promptDir: string;
  repositoryContext: string;
  stageContract: string;
}

export function renderPrompts(options: RenderPromptOptions): { prompt: string; system: string } {
  const sharedDir = join(assetRoot(), "prompts", "_shared");
  const dir = join(assetRoot(), "prompts", options.promptDir);
  const system = [
    readFileSync(join(sharedDir, "system.md"), "utf8").trim(),
    readFileSync(join(dir, "system.md"), "utf8").trim(),
  ].join("\n\n");
  const userTemplate = [
    readFileSync(join(sharedDir, "user.md"), "utf8").trim(),
    readFileSync(join(dir, "user.md"), "utf8").trim(),
  ].join("\n\n");
  const prompt = userTemplate
    .replace("{{github_context}}", xmlJson("github_context", options.context))
    .replace("{{repository_context}}", xmlText("repository_context", options.repositoryContext))
    .replace("{{stage_contract}}", xmlText("stage_contract", options.stageContract))
    .replace("{{output_schema}}", xmlJson("output_schema", options.outputSchema));

  return { prompt, system };
}

function xmlJson(name: string, value: unknown): string {
  return `<${name}>\n${JSON.stringify(value, null, 2)}\n</${name}>`;
}

function xmlText(name: string, value: string): string {
  return `<${name}>\n${value}\n</${name}>`;
}

function assetRoot(): string {
  return (
    process.env.GITVIBE_ASSET_ROOT ||
    (process.env.GITHUB_ACTION_PATH ? dirname(process.env.GITHUB_ACTION_PATH) : process.cwd())
  );
}
