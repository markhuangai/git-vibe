import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseStage } from "../shared/stages.js";
import type {
  ContextPacket,
  JsonObject,
  Stage,
  StageHandoff,
  StageRunResult,
} from "../shared/types.js";

export function withStageHandoffs(context: ContextPacket, handoffDir?: string): ContextPacket {
  const handoffs = loadStageHandoffs(handoffDir);
  return handoffs.length ? { ...context, handoffs } : context;
}

export function writeStageResultFile(options: {
  directory: string;
  result: StageRunResult;
  stage: Stage;
}): string {
  const file = join(options.directory, `git-vibe-${options.stage}-result.json`);
  writeFileSync(file, JSON.stringify(stageHandoff(options.stage, options.result), null, 2));
  return file;
}

function loadStageHandoffs(handoffDir?: string): StageHandoff[] {
  if (!handoffDir) return [];

  try {
    return readdirSync(handoffDir)
      .filter((file) => /^git-vibe-[a-z-]+-result\.json$/.test(file))
      .map((file) => parseStageHandoff(readFileSync(join(handoffDir, file), "utf8")))
      .filter((handoff): handoff is StageHandoff => Boolean(handoff));
  } catch {
    return [];
  }
}

function parseStageHandoff(content: string): StageHandoff | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isObject(parsed) || !isObject(parsed.parsedOutput)) return undefined;
    const stage = stageField(parsed.stage);
    const schemaId = stringField(parsed.schemaId);
    const status = stringField(parsed.status);
    const summary = stringField(parsed.summary);
    if (!stage || !schemaId || !status || !summary) return undefined;

    return {
      commentBody: stringField(parsed.commentBody),
      parsedOutput: parsed.parsedOutput,
      schemaId,
      stage,
      status,
      summary,
    };
  } catch {
    return undefined;
  }
}

function stageHandoff(stage: Stage, result: StageRunResult): StageHandoff {
  return {
    commentBody: result.commentBody,
    parsedOutput: result.parsedOutput,
    schemaId: result.schemaId,
    stage,
    status: result.status,
    summary: result.summary,
  };
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stageField(value: unknown): Stage | undefined {
  const stage = stringField(value);
  if (!stage) return undefined;

  try {
    return parseStage(stage);
  } catch {
    return undefined;
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
