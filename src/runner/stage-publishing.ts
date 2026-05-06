import { addDiscussionComment } from "../shared/discussions.js";
import { GitHubClient, splitRepository } from "../shared/github.js";
import { gitVibeLabels } from "../shared/labels.js";
import type { StageLogger } from "./logging.js";
import { renderStageResultComment, type StageResultLink } from "./result-comments.js";
import type {
  ContextPacket,
  JsonObject,
  RunnerOptions,
  SourceComment,
  Stage,
} from "../shared/types.js";

export interface StagePublishingOptions {
  client: GitHubClient;
  context: ContextPacket;
  links?: StageResultLink[];
  logger: StageLogger;
  parsedOutput: JsonObject;
  runner: RunnerOptions;
}

export async function publishStageResultComment(options: StagePublishingOptions): Promise<void> {
  const body = renderStageResultComment({
    context: options.context,
    links: options.links,
    parsedOutput: options.parsedOutput,
    stage: options.runner.stage,
    workflowRunUrl: options.runner.workflowRunUrl,
  });
  await publishArtifactComment({ ...options, body });
}

export async function applyStageLabelTransition(options: StagePublishingOptions): Promise<void> {
  if (options.context.artifact.type === "discussion") return;
  const label = labelForStage(options.runner.stage, options.parsedOutput);
  if (!label) return;

  options.logger.event("github.issue.label.start", {
    issue: options.context.artifact.number,
    label,
  });
  await addIssueLabel({
    client: options.client,
    issueNumber: options.context.artifact.number,
    label,
    repository: options.runner.repository,
    token: options.runner.token,
  });
  options.logger.event("github.issue.label.done", {
    issue: options.context.artifact.number,
    label,
  });
}

async function publishArtifactComment(options: StagePublishingOptions & { body: string }) {
  const artifact = options.context.artifact;
  if (artifact.type === "discussion") {
    await publishDiscussionComment(options);
    return;
  }

  if (artifact.type === "pull-request" && isPullRequestReviewReply(options.runner.sourceComment)) {
    await publishPullRequestReviewReply(options);
    return;
  }

  options.logger.event("github.issue.comment.start", {
    artifact: `${artifact.type}#${artifact.number}`,
    source_comment_kind: options.runner.sourceComment?.kind || "",
  });
  await createIssueComment({
    body: flatReplyBody(options.body, options.runner.sourceComment),
    client: options.client,
    issueNumber: artifact.number,
    repository: options.runner.repository,
    token: options.runner.token,
  });
  options.logger.event("github.issue.comment.done", {
    artifact: `${artifact.type}#${artifact.number}`,
  });
}

async function publishDiscussionComment(options: StagePublishingOptions & { body: string }) {
  const artifact = options.context.artifact;
  if (!artifact.id) {
    options.logger.event("github.discussion.comment.skip", {
      discussion: artifact.number,
      reason: "missing-discussion-id",
    });
    return;
  }

  options.logger.event("github.discussion.comment.start", {
    discussion: artifact.number,
    reply_to: discussionReplyToId(options.runner) || "",
  });
  await addDiscussionComment({
    body: options.body,
    client: options.client,
    discussionId: artifact.id,
    replyToId: discussionReplyToId(options.runner),
    token: options.runner.token,
  });
  options.logger.event("github.discussion.comment.done", { discussion: artifact.number });
}

async function publishPullRequestReviewReply(
  options: StagePublishingOptions & { body: string },
): Promise<void> {
  const commentId = options.runner.sourceComment?.id || "";
  const artifact = options.context.artifact;
  const { owner, repo } = splitRepository(options.runner.repository);

  options.logger.event("github.pr.review_comment.reply.start", {
    comment: commentId,
    pull_request: artifact.number,
  });
  await options.client.request({
    body: { body: options.body },
    method: "POST",
    path: `/repos/${owner}/${repo}/pulls/${artifact.number}/comments/${commentId}/replies`,
    token: options.runner.token,
  });
  options.logger.event("github.pr.review_comment.reply.done", {
    comment: commentId,
    pull_request: artifact.number,
  });
}

async function createIssueComment(options: {
  body: string;
  client: GitHubClient;
  issueNumber: string;
  repository: string;
  token: string;
}): Promise<void> {
  const { owner, repo } = splitRepository(options.repository);
  await options.client.request({
    body: { body: options.body },
    method: "POST",
    path: `/repos/${owner}/${repo}/issues/${options.issueNumber}/comments`,
    token: options.token,
  });
}

async function addIssueLabel(options: {
  client: GitHubClient;
  issueNumber: string;
  label: string;
  repository: string;
  token: string;
}): Promise<void> {
  const { owner, repo } = splitRepository(options.repository);
  await options.client.request({
    body: { labels: [options.label] },
    method: "POST",
    path: `/repos/${owner}/${repo}/issues/${options.issueNumber}/labels`,
    token: options.token,
  });
}

function labelForStage(stage: Stage, output: JsonObject): string | undefined {
  if (String(output.status || "completed") !== "completed") return gitVibeLabels.blocked.name;
  if (stage === "validate" && isReadyForApproval(output.next_state)) {
    return gitVibeLabels.readyForApproval.name;
  }
  if (stage === "implement") return gitVibeLabels.inProgress.name;
  if (stage === "create-pr") return gitVibeLabels.prOpened.name;
  return undefined;
}

function discussionReplyToId(runner: RunnerOptions): string | undefined {
  const source = runner.sourceComment;
  return source?.kind === "discussion-comment" ? source.nodeId : undefined;
}

function flatReplyBody(body: string, source: SourceComment | undefined): string {
  if (!source?.url) return body;
  if (isThreadedSource(source)) return body;
  return `${body}\n\n---\nIn reply to: ${source.url}`;
}

function isPullRequestReviewReply(source: SourceComment | undefined): boolean {
  return Boolean(source?.kind === "pull-request-review-comment" && source.id);
}

function isThreadedSource(source: SourceComment): boolean {
  return source.kind === "discussion-comment";
}

function isReadyForApproval(value: unknown): boolean {
  const state = String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-")
    .replace(/\s+/g, "-");
  return state === "ready" || state.endsWith(":ready") || state.includes("ready-for-approval");
}
