import { GitHubClient, splitRepository } from "../shared/github.js";
import type { ContextPacket, JsonObject, RunnerOptions } from "../shared/types.js";
import type { StageLogger } from "./logging.js";

interface PullRequestReviewComment {
  body: string;
  line: number;
  path: string;
  side: "LEFT" | "RIGHT";
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
}

export async function publishPullRequestReviewResult(options: {
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  parsedOutput: JsonObject;
  runner: RunnerOptions;
}): Promise<void> {
  if (!shouldPublishPullRequestReview(options)) return;

  const comments = inlineReviewComments(options.parsedOutput.inline_comments);
  options.logger.event("github.pr.review.start", {
    comments: comments.length,
    pull_request: options.context.artifact.number,
  });
  await createPullRequestReview({
    body: pullRequestReviewBody({
      comments,
      output: options.parsedOutput,
      workflowRunUrl: options.runner.workflowRunUrl,
    }),
    client: options.client,
    comments,
    pullNumber: options.context.artifact.number,
    repository: options.runner.repository,
    token: options.runner.token,
  });
  options.logger.event("github.pr.review.done", {
    comments: comments.length,
    pull_request: options.context.artifact.number,
  });
}

function shouldPublishPullRequestReview(options: {
  context: ContextPacket;
  parsedOutput: JsonObject;
  runner: RunnerOptions;
}): boolean {
  return (
    options.runner.stage === "review-matrix" &&
    options.context.artifact.type === "pull-request" &&
    normalizedState(options.parsedOutput.next_state) === "changes-required"
  );
}

async function createPullRequestReview(options: {
  body: string;
  client: GitHubClient;
  comments: PullRequestReviewComment[];
  pullNumber: string;
  repository: string;
  token: string;
}): Promise<void> {
  const { owner, repo } = splitRepository(options.repository);
  await options.client.request({
    body: {
      body: options.body,
      comments: options.comments.length ? options.comments : undefined,
      event: "COMMENT",
    },
    method: "POST",
    path: `/repos/${owner}/${repo}/pulls/${options.pullNumber}/reviews`,
    token: options.token,
  });
}

function inlineReviewComments(value: unknown): PullRequestReviewComment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("review-matrix inline_comments must be an array.");
  }
  return value.map((item, index) => inlineReviewComment(item, index));
}

function inlineReviewComment(value: unknown, index: number): PullRequestReviewComment {
  if (!isRecord(value)) {
    throw new Error(`review-matrix inline_comments[${index}] must be an object.`);
  }
  const path = stringField(value.path);
  const body = stringField(value.body);
  const line = integerField(value.line);
  if (!path || !body || line === undefined) {
    throw new Error(`review-matrix inline_comments[${index}] must define path, line, and body.`);
  }

  const side = sideField(value.side);
  const comment: PullRequestReviewComment = { body, line, path, side };
  const startLine = integerField(value.start_line);
  if (startLine !== undefined) {
    if (startLine > line) {
      throw new Error(
        `review-matrix inline_comments[${index}].start_line must be less than or equal to line.`,
      );
    }
    comment.start_line = startLine;
    comment.start_side = side;
  }
  return comment;
}

function pullRequestReviewBody(options: {
  comments: PullRequestReviewComment[];
  output: JsonObject;
  workflowRunUrl?: string;
}): string {
  const findings = stringItems(options.output.findings);
  return cleanLines([
    "## GitVibe Review Matrix",
    "",
    stringField(options.output.summary) || "Review matrix found required changes.",
    "",
    "**Next state:** `changes-required`",
    `**Inline comments:** ${options.comments.length}`,
    ...findingsSection(findings),
    ...workflowRunSection(options.workflowRunUrl),
  ]).join("\n");
}

function findingsSection(findings: string[]): string[] {
  if (!findings.length) return [];
  return [
    "",
    "### Required Fixes",
    ...findings.map((finding, index) => `${index + 1}. ${finding}`),
  ];
}

function workflowRunSection(url: string | undefined): string[] {
  return url ? ["", `Workflow run: ${url}`] : [];
}

function stringItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function integerField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function sideField(value: unknown): "LEFT" | "RIGHT" {
  return value === "LEFT" || value === "RIGHT" ? value : "RIGHT";
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedState(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-")
    .replace(/\s+/g, "-");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
