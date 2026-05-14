import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseStage } from "../shared/stages.js";
import type {
  ContextPacket,
  JsonObject,
  Stage,
  StageHandoff,
  StageRunResult,
  TimelineItem,
} from "../shared/types.js";

export function withStageHandoffs(context: ContextPacket, handoffDir?: string): ContextPacket {
  const handoffs = uniqueHandoffs([
    ...stageResultCommentHandoffs(context.timeline),
    ...loadStageHandoffs(handoffDir),
  ]);
  return handoffs.length ? { ...context, handoffs } : context;
}

export function stageResultCommentHandoffs(timeline: TimelineItem[]): StageHandoff[] {
  return timeline
    .map((item) => parseStageResultCommentHandoff(item.body))
    .filter((handoff): handoff is StageHandoff => Boolean(handoff));
}

export function writeStageResultFile(options: {
  directory: string;
  metadata?: JsonObject;
  result: StageRunResult;
  stage: Stage;
}): string {
  const file = join(options.directory, `git-vibe-${options.stage}-result.json`);
  writeFileSync(
    file,
    JSON.stringify(
      { ...stageHandoff(options.stage, options.result), ...options.metadata },
      null,
      2,
    ),
  );
  return file;
}

export function writeStageResultSummary(options: {
  metadata?: JsonObject;
  result: StageRunResult;
  stage: Stage;
  summaryPath?: string;
}): void {
  if (!options.summaryPath) return;
  appendFileSync(options.summaryPath, `${renderStageResultSummary(options)}\n`);
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

function parseStageResultCommentHandoff(body: string): StageHandoff | undefined {
  const attributes = stageResultAttributes(body);
  const stage = stageField(attributes.stage);
  if (!stage) return undefined;

  const lines = body.split(/\r?\n/);
  const status = statusFromComment(lines) || "completed";
  const summary = summaryFromComment(lines) || `${stage} stage result.`;
  const sections = sectionsFromComment(lines);
  const parsedOutput = {
    ...sections,
    comment_body: stringField(sections.comment_body) || body.trim(),
    stage,
    status,
    summary,
  };

  return {
    commentBody: body.trim(),
    parsedOutput,
    schemaId: `${stage}.v1`,
    stage,
    status,
    summary,
  };
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

function renderStageResultSummary(options: {
  metadata?: JsonObject;
  result: StageRunResult;
  stage: Stage;
}): string {
  const role = stringField(options.metadata?.role);
  const profile = stringField(options.metadata?.profile);
  return [
    `## GitVibe ${options.stage} result`,
    "",
    `- Status: \`${inlineCodeValue(options.result.status)}\``,
    `- Schema: \`${inlineCodeValue(options.result.schemaId)}\``,
    ...(role ? [`- Role: \`${inlineCodeValue(role)}\``] : []),
    ...(profile ? [`- Profile: \`${inlineCodeValue(profile)}\``] : []),
    "",
    options.result.summary,
    "",
    "### GitHub Comment",
    "",
    options.result.commentBody,
    "",
    "### Structured Output",
    "",
    "````json",
    JSON.stringify(options.result.parsedOutput, null, 2),
    "````",
  ].join("\n");
}

function inlineCodeValue(value: string): string {
  return value.replaceAll("`", "'");
}

function uniqueHandoffs(handoffs: StageHandoff[]): StageHandoff[] {
  const seen = new Set<string>();
  const unique: StageHandoff[] = [];
  for (const handoff of handoffs) {
    const key = [
      handoff.stage,
      handoff.schemaId,
      handoff.status,
      handoff.summary,
      handoff.commentBody || "",
    ].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(handoff);
  }
  return unique;
}

function stageResultAttributes(body: string): Record<string, string | undefined> {
  const match = body.match(/<!--\s*git-vibe:stage-result\s+([^>]*)-->/);
  return match ? parseAttributes(match[1] || "") : {};
}

function parseAttributes(value: string): Record<string, string | undefined> {
  const attributes: Record<string, string | undefined> = {};
  for (const match of value.matchAll(/([a-z][a-z-]*)=([^\s>]+)/g)) {
    attributes[match[1] || ""] = match[2];
  }
  return attributes;
}

function statusFromComment(lines: string[]): string | undefined {
  const line = lines.find((value) => value.includes("**Status:**"));
  return line?.match(/`([^`]+)`/)?.[1];
}

function summaryFromComment(lines: string[]): string | undefined {
  const statusIndex = lines.findIndex((line) => line.includes("**Status:**"));
  if (statusIndex < 0) return undefined;

  const summary: string[] = [];
  for (const rawLine of lines.slice(statusIndex + 1)) {
    const line = rawLine.trim();
    if (!line) {
      if (summary.length) break;
      continue;
    }
    if (line.startsWith("**Next state:**")) continue;
    if (line.startsWith("### ")) break;
    summary.push(line);
  }
  return summary.join("\n").trim() || undefined;
}

function sectionsFromComment(lines: string[]): JsonObject {
  const sections: JsonObject = {};
  let title = "";
  let values: string[] = [];
  const flush = () => {
    if (!title) return;
    const field = sectionField(title);
    const cleaned = values.map(cleanSectionLine).filter(Boolean);
    sections[field] = field === "comment_body" ? cleaned.join("\n") : cleaned;
  };

  for (const rawLine of lines) {
    const heading = rawLine.match(/^###\s+(.+)$/);
    if (heading) {
      flush();
      title = heading[1] || "";
      values = [];
      continue;
    }
    if (title && rawLine.trim()) values.push(rawLine);
  }
  flush();
  return sections;
}

function sectionField(title: string): string {
  const normalized = title.toLowerCase().replace(/\s+or\s+/g, " ");
  const known: Record<string, string> = {
    "already working": "working_capabilities",
    "blocking questions": "blocking_questions",
    details: "comment_body",
    findings: "findings",
    "implementation plan": "implementation_plan",
    "key findings": "findings",
    "not working yet": "missing_capabilities",
    "open questions": "questions",
    "partial unclear": "partial_capabilities",
    references: "references",
    tests: "tests",
  };
  return known[normalized] || normalized.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function cleanSectionLine(value: string): string {
  return value.trim().replace(/^-\s+/, "").trim();
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
