import { GitHubClient, splitRepository } from "../shared/github.js";
import { workflowRunIdFromUrl } from "../shared/status-comments.js";
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

interface AuthenticatedUserResponse extends JsonObject {
  login?: string;
}

export async function publishPullRequestReviewResult(options: {
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  parsedOutput: JsonObject;
  runner: RunnerOptions;
  stageResultBody: string;
}): Promise<boolean> {
  if (!shouldPublishPullRequestReview(options)) return false;

  const comments = inlineReviewComments(options.parsedOutput.inline_comments);
  const body = pullRequestReviewBody({
    comments,
    output: options.parsedOutput,
    stageResultBody: options.stageResultBody,
    workflowRunUrl: options.runner.workflowRunUrl,
  });
  const existingReview = await editableReviewForStageResult({ ...options, comments });
  if (existingReview) {
    options.logger.event("github.pr.review.update.start", {
      pull_request: options.context.artifact.number,
      review: existingReview.reviewId,
      run: workflowRunIdFromUrl(options.runner.workflowRunUrl),
    });
    await updatePullRequestReview({
      body,
      client: options.client,
      pullNumber: options.context.artifact.number,
      repository: options.runner.repository,
      reviewId: existingReview.reviewId,
      token: options.runner.token,
    });
    options.logger.event("github.pr.review.update.done", {
      pull_request: options.context.artifact.number,
      review: existingReview.reviewId,
      run: workflowRunIdFromUrl(options.runner.workflowRunUrl),
    });
    return true;
  }

  options.logger.event("github.pr.review.start", {
    comments: comments.length,
    pull_request: options.context.artifact.number,
  });
  await createPullRequestReview({
    body,
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
  return true;
}

function shouldPublishPullRequestReview(options: {
  context: ContextPacket;
  parsedOutput: JsonObject;
  runner: RunnerOptions;
}): boolean {
  return (
    options.runner.stage === "review-matrix" && options.context.artifact.type === "pull-request"
  );
}

async function editableReviewForStageResult(options: {
  client: GitHubClient;
  comments: PullRequestReviewComment[];
  context: ContextPacket;
  runner: RunnerOptions;
}): Promise<{ reviewId: string } | undefined> {
  if (options.comments.length > 0) return undefined;
  const run = workflowRunIdFromUrl(options.runner.workflowRunUrl);
  if (!run) return undefined;
  const candidates: Array<{ author: string; reviewId: string }> = [];
  for (const item of options.context.timeline) {
    if (item.kind !== "pull-request-review") continue;
    const reviewId = reviewDatabaseId(item.databaseId);
    if (!reviewId) continue;
    const marker = parseStageResultMarker(item.body);
    if (
      marker?.artifact === options.context.artifact.type &&
      marker.number === options.context.artifact.number &&
      marker.stage === options.runner.stage &&
      markerMatchesRun(marker, item.body, run) &&
      reviewInlineCommentCount(item.body) === 0
    ) {
      candidates.push({ author: item.author, reviewId });
    }
  }
  if (!candidates.length) return undefined;

  const login = await authenticatedGitHubLogin({
    client: options.client,
    token: options.runner.token,
  });
  let editableReview: { reviewId: string } | undefined;
  for (const candidate of candidates) {
    if (sameGitHubLogin(candidate.author, login)) {
      editableReview = { reviewId: candidate.reviewId };
    }
  }
  return editableReview;
}

function parseStageResultMarker(
  body: string,
): { artifact: string; number: string; run?: string; stage: string } | undefined {
  const match = body.match(/<!--\s*git-vibe:stage-result\s+([^>]*)-->/);
  if (!match) return undefined;
  const attributes = Object.fromEntries(
    [...(match[1] || "").matchAll(/([a-z][a-z-]*)=([^\s>]+)/g)].map((entry) => [
      entry[1],
      entry[2],
    ]),
  );
  if (!attributes.stage || !attributes.artifact || !attributes.number) return undefined;
  return {
    artifact: attributes.artifact,
    number: attributes.number,
    run: attributes.run,
    stage: attributes.stage,
  };
}

function markerMatchesRun(marker: { run?: string }, body: string, run: string): boolean {
  if (marker.run) return marker.run === run;
  return body.includes(`/actions/runs/${run}`);
}

function reviewInlineCommentCount(body: string): number {
  const match = body.match(/\*\*Inline comments:\*\*\s+(\d+)/);
  return match ? Number(match[1]) : 0;
}

function reviewDatabaseId(value: number | string | undefined): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return undefined;
}

function sameGitHubLogin(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

async function authenticatedGitHubLogin(options: {
  client: GitHubClient;
  token: string;
}): Promise<string> {
  const user = await options.client.request<AuthenticatedUserResponse>({
    method: "GET",
    path: "/user",
    token: options.token,
  });
  const login = stringField(user.login);
  if (!login) {
    throw new Error(
      "GitHub authenticated user did not include login; cannot safely update PR review.",
    );
  }
  return login;
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

async function updatePullRequestReview(options: {
  body: string;
  client: GitHubClient;
  pullNumber: string;
  repository: string;
  reviewId: string;
  token: string;
}): Promise<void> {
  const { owner, repo } = splitRepository(options.repository);
  await options.client.request({
    body: { body: options.body },
    method: "PUT",
    path: `/repos/${owner}/${repo}/pulls/${options.pullNumber}/reviews/${options.reviewId}`,
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
  stageResultBody: string;
  workflowRunUrl?: string;
}): string {
  const findings = stringItems(options.output.findings);
  return cleanLines([
    ...options.stageResultBody.split(/\r?\n/),
    ...reviewDetailsSection({ comments: options.comments, findings }),
    ...fallbackWorkflowRunSection(options.stageResultBody, options.workflowRunUrl),
  ]).join("\n");
}

function reviewDetailsSection(options: {
  comments: PullRequestReviewComment[];
  findings: string[];
}): string[] {
  if (!options.comments.length && !options.findings.length) return [];
  return [
    "",
    `**Inline comments:** ${options.comments.length}`,
    ...findingsSection(options.findings),
  ];
}

function findingsSection(findings: string[]): string[] {
  if (!findings.length) return [];
  return [
    "",
    "### Required Fixes",
    ...findings.map((finding, index) => `${index + 1}. ${finding}`),
  ];
}

function fallbackWorkflowRunSection(body: string, url: string | undefined): string[] {
  if (!url || body.includes(`Workflow run: ${url}`)) return [];
  return ["", `Workflow run: ${url}`];
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
