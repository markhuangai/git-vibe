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
  implement: "Implementation Update",
  investigate: "Investigation",
  materialize: "Implementation Issue",
  "review-matrix": "Review Matrix",
  summarize: "Discussion Summary",
  validate: "Validation",
};

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
    `## GitVibe ${stageTitles[options.stage]} Running`,
    "",
    `GitVibe is running the ${inlineCode(options.stage)} stage for ${artifact.type} #${artifact.number}.`,
    "",
    options.workflowRunUrl ? `Workflow run: ${options.workflowRunUrl}` : "",
  ];
  return cleanLines(lines).join("\n");
}

export function renderStageResultComment(options: StageResultCommentOptions): string {
  if (options.stage === "investigate" || options.stage === "validate") {
    return renderCompactStageResultComment(options);
  }

  const output = options.parsedOutput;
  const lines = [
    resultMarker(options),
    `## GitVibe ${stageTitles[options.stage]}`,
    "",
    `**Status:** ${inlineCode(textField(output.status) || "completed")}`,
    stateLine(output),
    "",
    textField(output.summary) || "No summary provided.",
    ...detailsSection(output),
    ...listSection("Already Working", arrayField(output.working_capabilities)),
    ...listSection("Not Working Yet", arrayField(output.missing_capabilities)),
    ...listSection("Partial Or Unclear", arrayField(output.partial_capabilities)),
    ...listSection("Findings", arrayField(output.findings)),
    ...listSection("Blocking Questions", arrayField(output.blocking_questions)),
    ...investigationRetrySection(options.stage, output),
    ...listSection("Open Questions", arrayField(output.questions)),
    ...listSection("Implementation Plan", arrayField(output.implementation_plan)),
    ...listSection("Assumptions", arrayField(output.assumptions)),
    ...listSection("Proposed Labels", arrayField(output.proposed_labels)),
    ...issueSection(output),
    ...pullRequestSection(output),
    ...listSection("Tests", arrayField(output.tests)),
    ...listSection("Skipped Feedback", arrayField(output.skipped_feedback)),
    ...referencesSection(output, options),
  ];

  return cleanLines(lines).join("\n");
}

function renderCompactStageResultComment(options: StageResultCommentOptions): string {
  const output = options.parsedOutput;
  const lines = [
    resultMarker(options),
    `## GitVibe ${stageTitles[options.stage]}`,
    "",
    `**Status:** ${inlineCode(textField(output.status) || "completed")}`,
    stateLine(output),
    "",
    textField(output.summary) || "No summary provided.",
    ...compactValidationSection(options.stage, output),
    ...listSection("Blocking Questions", limitList(arrayField(output.blocking_questions), 5)),
    ...compactNextActionSection(options.stage, output),
    ...listSection("Key Findings", limitList(arrayField(output.findings), 5)),
    ...listSection("Implementation Plan", limitList(arrayField(output.implementation_plan), 5)),
    ...listSection("Open Questions", limitList(arrayField(output.questions), 5)),
    ...referencesSection(output, options),
  ];
  return cleanLines(lines).join("\n");
}

function resultMarker(options: StageResultCommentOptions): string {
  const artifact = options.context.artifact;
  return `<!-- git-vibe:stage-result stage=${options.stage} artifact=${artifact.type} number=${artifact.number} -->`;
}

function stateLine(output: JsonObject): string {
  const nextState = textField(output.next_state);
  return nextState ? `**Next state:** ${inlineCode(nextState)}` : "";
}

function detailsSection(output: JsonObject): string[] {
  const details = textField(output.comment_body);
  const summary = textField(output.summary);
  if (!details || details.trim() === summary.trim()) return [];
  return ["", "### Details", details];
}

function issueSection(output: JsonObject): string[] {
  const title = textField(output.issue_title);
  const body = textField(output.issue_body);
  if (!title && !body) return [];
  return ["", "### Proposed Implementation Issue", title ? `**Title:** ${title}` : "", body];
}

function pullRequestSection(output: JsonObject): string[] {
  const branch = textField(output.branch);
  const title = textField(output.pr_title);
  const body = textField(output.pr_body);
  if (!branch && !title && !body) return [];
  return [
    "",
    "### Pull Request",
    branch ? `**Branch:** ${inlineCode(branch)}` : "",
    title ? `**Title:** ${title}` : "",
    body,
  ];
}

function referencesSection(output: JsonObject, options: StageResultCommentOptions): string[] {
  const references = [
    ...arrayField(output.references),
    ...linkReferences(options.links || []),
    options.workflowRunUrl ? `Workflow run: ${options.workflowRunUrl}` : "",
  ].filter(Boolean);
  return listSection("References", uniqueStrings(references));
}

function compactValidationSection(stage: Stage, output: JsonObject): string[] {
  if (stage !== "validate") return [];
  const working = arrayField(output.working_capabilities).length;
  const missing = arrayField(output.missing_capabilities).length;
  const partial = arrayField(output.partial_capabilities).length;
  if (!working && !missing && !partial) return [];
  return [
    "",
    "### Capability Status",
    `- Working: ${working}`,
    `- Missing: ${missing}`,
    `- Partial or unclear: ${partial}`,
  ];
}

function compactNextActionSection(stage: Stage, output: JsonObject): string[] {
  if (stage === "investigate" && arrayField(output.blocking_questions).length) {
    return investigationRetrySection(stage, output);
  }
  const nextState = textField(output.next_state);
  if (!nextState || nextState === "blocked") return [];
  return ["", "### Next Action", `Continue with ${inlineCode(nextState)}.`];
}

function listSection(title: string, values: string[]): string[] {
  if (!values.length) return [];
  return ["", `### ${title}`, ...values.map((value) => `- ${value}`)];
}

function limitList(values: string[], limit: number): string[] {
  if (values.length <= limit) return values;
  return [...values.slice(0, limit), `${values.length - limit} more in the stage result artifact.`];
}

function investigationRetrySection(stage: Stage, output: JsonObject): string[] {
  if (stage !== "investigate" || !arrayField(output.blocking_questions).length) return [];
  return [
    "",
    "### Next Human Action",
    "Answer the blocking questions, then add `git-vibe:investigate` to rerun investigation before implementation approval.",
  ];
}

function linkReferences(links: StageResultLink[]): string[] {
  return links.filter((link) => link.url).map((link) => `${link.label}: ${link.url}`);
}

function arrayField(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "'")}\``;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
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
