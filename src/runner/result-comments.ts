import type { ContextPacket, JsonObject, Stage } from "../shared/types.js";
import { stageStartMarker, workflowRunIdFromUrl } from "../shared/status-comments.js";

export interface StageResultLink {
  label: string;
  url: string;
}

export interface StageResultCommentOptions {
  context: ContextPacket;
  links?: StageResultLink[];
  parsedOutput: JsonObject;
  stage: Stage;
  workflowRunUrl?: string;
}

const stageTitles: Record<Stage, string> = {
  "address-pr-feedback": "PR Feedback Update",
  "create-pr": "Pull Request Update",
  decompose: "Decomposition Plan",
  implement: "Implementation Update",
  investigate: "Investigation",
  materialize: "Implementation Issue",
  "review-matrix": "Review Matrix",
  summarize: "Discussion Summary",
  validate: "Validation",
};

interface NormalizedQuestion {
  blocking: boolean;
  options: string[];
  question: string;
}

export interface DecomposeResultMarker {
  artifact: "discussion";
  number: string;
  schema: string;
}

const decomposeJsonStartPattern =
  /<!--\s*git-vibe:decompose-json(?<attributes>[^>]*)-->\s*(?:```json\s*)?(?<json>[\s\S]*?)(?:\s*```)?\s*<!--\s*\/git-vibe:decompose-json\s*-->/;

export function renderStageStartComment(options: {
  context: ContextPacket;
  stage: Stage;
  workflowRunUrl?: string;
}): string {
  const artifact = options.context.artifact;
  const lines = [
    stageStartMarker({
      artifact: artifact.type,
      number: artifact.number,
      run: workflowRunIdFromUrl(options.workflowRunUrl),
      stage: options.stage,
    }),
    `## GitVibe ${stageTitle(options)} Running`,
    "",
    `GitVibe is running the ${inlineCode(options.stage)} stage for ${artifact.type} #${artifact.number}.`,
    "",
    options.workflowRunUrl ? `Workflow run: ${options.workflowRunUrl}` : "",
  ];
  return cleanLines(lines).join("\n");
}

export function renderStageResultComment(options: StageResultCommentOptions): string {
  if (isCompletedDecomposeResult(options)) return renderDecomposeResultComment(options);

  const output = options.parsedOutput;
  const questions = normalizedQuestions(output);
  const lines = [
    resultMarker(options),
    `## GitVibe ${stageTitle(options)}`,
    "",
    `**Status:** ${inlineCode(textField(output.status) || "completed")}`,
    stateLine(output),
    "",
    textField(output.summary) || "No summary provided.",
    ...questionsSection(questions),
    ...compactNextActionSection(output, questions.length > 0),
    ...resultSection(options),
  ];

  return cleanLines(lines).join("\n");
}

export function parseDecomposeResultMarker(
  body: string | null | undefined,
): DecomposeResultMarker | undefined {
  const marker = String(body || "").match(
    /<!--\s*git-vibe:decompose-result(?<attributes>[^>]*)-->/,
  );
  if (!marker?.groups?.attributes) return undefined;
  const attributes = markerAttributes(marker.groups.attributes);
  if (attributes.artifact !== "discussion" || !attributes.number) return undefined;
  return {
    artifact: "discussion",
    number: attributes.number,
    schema: attributes.schema || "",
  };
}

export function parseDecomposeJson(body: string | null | undefined): JsonObject | undefined {
  const match = String(body || "").match(decomposeJsonStartPattern);
  if (!match?.groups?.json) return undefined;
  const parsed = JSON.parse(match.groups.json.trim()) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as JsonObject)
    : undefined;
}

function isCompletedDecomposeResult(options: StageResultCommentOptions): boolean {
  return (
    options.stage === "decompose" &&
    options.context.artifact.type === "discussion" &&
    textField(options.parsedOutput.status) === "completed"
  );
}

function renderDecomposeResultComment(options: StageResultCommentOptions): string {
  const output = options.parsedOutput;
  const lines = [
    resultMarker(options),
    decomposeResultMarker(options),
    `## GitVibe ${stageTitle(options)}`,
    "",
    `**Status:** ${inlineCode(textField(output.status) || "completed")}`,
    stateLine(output),
    "",
    textField(output.summary) || "No summary provided.",
    "",
    "### Story Units",
    ...storyUnitLines(output.story_units),
    "",
    "### Machine Data",
    decomposeJsonStartMarker(options),
    "```json",
    JSON.stringify(output, null, 2),
    "```",
    "<!-- /git-vibe:decompose-json -->",
    ...resultSection(options),
  ];

  return cleanLines(lines).join("\n");
}

function resultMarker(options: StageResultCommentOptions): string {
  const artifact = options.context.artifact;
  return `<!-- git-vibe:stage-result stage=${options.stage} artifact=${artifact.type} number=${artifact.number} -->`;
}

function decomposeResultMarker(options: StageResultCommentOptions): string {
  const artifact = options.context.artifact;
  return `<!-- git-vibe:decompose-result artifact=discussion number=${artifact.number} schema=${stageSchema(options.stage)} -->`;
}

function decomposeJsonStartMarker(options: StageResultCommentOptions): string {
  return `<!-- git-vibe:decompose-json schema=${stageSchema(options.stage)} -->`;
}

function stageSchema(stage: Stage): string {
  return `${stage}.v1`;
}

function stageTitle(options: Pick<StageResultCommentOptions, "context" | "stage">): string {
  if (options.stage === "investigate" && options.context.artifact.type === "pull-request") {
    return "PR Feedback Investigation";
  }
  return stageTitles[options.stage];
}

function stateLine(output: JsonObject): string {
  const nextState = textField(output.next_state);
  return nextState ? `**Next state:** ${inlineCode(nextState)}` : "";
}

function questionsSection(questions: NormalizedQuestion[]): string[] {
  if (!questions.length) return [];
  return ["", "### Questions", ...questions.flatMap(questionLines)];
}

function questionLines(question: NormalizedQuestion, index: number): string[] {
  const prefix = question.blocking ? "[Blocking] " : "";
  const options = question.options.slice(0, 4);
  return [
    `${index + 1}. ${prefix}${question.question}`,
    ...options.map((option, optionIndex) => `   ${optionLetter(optionIndex)}. ${option}`),
  ];
}

function compactNextActionSection(output: JsonObject, hasQuestions: boolean): string[] {
  if (hasQuestions) {
    return [
      "",
      "### Next Action",
      "Reply in one comment with question numbers and option letters, or write your own answer for any question.",
    ];
  }
  const nextState = textField(output.next_state);
  if (!nextState || nextState === "blocked") return [];
  return ["", "### Next Action", `Continue with ${inlineCode(nextState)}.`];
}

function resultSection(options: StageResultCommentOptions): string[] {
  const references = [
    "Full details are in the workflow run summary.",
    ...linkReferences(options.links || []),
    options.workflowRunUrl ? `Workflow run: ${options.workflowRunUrl}` : "",
  ].filter(Boolean);
  return ["", "### Result", ...references];
}

function storyUnitLines(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return ["No story units returned."];
  return value.flatMap((item, index) => storyUnitLine(item, index));
}

function storyUnitLine(item: unknown, index: number): string[] {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return [`${index + 1}. Invalid story unit; see machine data.`];
  }
  const unit = item as JsonObject;
  const title = textField(unit.title) || `Story ${index + 1}`;
  const requirements = stringItems(unit.requirements).slice(0, 3);
  const blockedBy = stringItems(unit.blocked_by);
  const reviewGuidelines = stringItems(unit.review_guidelines).slice(0, 2);
  const lines = [
    `${index + 1}. ${title}`,
    `   Parallel group: ${inlineCode(textField(unit.parallel_group) || "default")}`,
    `   Blocked by: ${blockedBy.length ? blockedBy.join(", ") : "None"}`,
  ];
  if (requirements.length) lines.push(`   Requirements: ${requirements.join("; ")}`);
  if (reviewGuidelines.length) {
    lines.push(`   Review: ${reviewGuidelines.join("; ")}`);
  }
  return lines;
}

function normalizedQuestions(output: JsonObject): NormalizedQuestion[] {
  return [
    ...questionItems(output.blocking_questions, true),
    ...questionItems(output.questions, false),
  ];
}

function questionItems(value: unknown, blocking: boolean): NormalizedQuestion[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeQuestion(item, blocking))
    .filter((item): item is NormalizedQuestion => item !== undefined);
}

function normalizeQuestion(item: unknown, blocking: boolean): NormalizedQuestion | undefined {
  if (typeof item === "string") {
    const question = item.trim();
    return question ? { blocking, options: [], question } : undefined;
  }
  if (!item || typeof item !== "object") return undefined;
  const fields = item as Record<string, unknown>;
  const question = textField(fields.question);
  if (!question) return undefined;
  return { blocking, options: stringItems(fields.options).slice(0, 4), question };
}

function linkReferences(links: StageResultLink[]): string[] {
  return links.filter((link) => link.url).map((link) => `${link.label}: ${link.url}`);
}

function stringItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function optionLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

function markerAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of value.matchAll(/([a-zA-Z0-9_-]+)=("[^"]*"|[^\s"]+)/g)) {
    const raw = match[2] || "";
    attributes[match[1] || ""] = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  }
  return attributes;
}

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "'")}\``;
}

function cleanLines(lines: string[]): string[] {
  const cleaned: string[] = [];
  for (const line of lines) {
    if (!line && cleaned.at(-1) === "") continue;
    cleaned.push(line);
  }
  while (cleaned.at(-1) === "") cleaned.pop();
  return cleaned;
}
