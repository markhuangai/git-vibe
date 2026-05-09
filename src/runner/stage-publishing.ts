import { addDiscussionComment, deleteDiscussionComment } from "../shared/discussions.js";
import { GitHubClient, splitRepository } from "../shared/github.js";
import { gitVibeLabels } from "../shared/labels.js";
import {
  matchesTransientStatusScope,
  parseTransientStatusMarker,
  workflowRunIdFromUrl,
  type TransientStatusScope,
} from "../shared/status-comments.js";
import { discussionReplyToId } from "./discussion-replies.js";
import type { StageLogger } from "./logging.js";
import {
  renderStageResultComment,
  renderStageStartComment,
  type StageResultLink,
} from "./result-comments.js";
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
  transientComments?: PublishedArtifactComment[];
}

type ArtifactCommentOptions = Omit<StagePublishingOptions, "parsedOutput"> & { body: string };

export interface PublishedArtifactComment {
  id: string;
  surface: "issue-comment" | "discussion-comment" | "pull-request-review-comment";
}

const staleTransientStatusCommentAgeMs = 30 * 60 * 1000;

export async function publishStageResultComment(options: StagePublishingOptions): Promise<void> {
  await cleanupStageStatusComments(options);
  const body = renderStageResultComment({
    context: options.context,
    links: options.links,
    parsedOutput: options.parsedOutput,
    stage: options.runner.stage,
    workflowRunUrl: options.runner.workflowRunUrl,
  });
  await publishArtifactComment({ ...options, body });
}

export async function cleanupStageStatusComments(
  options: Omit<StagePublishingOptions, "parsedOutput">,
): Promise<void> {
  await cleanupTransientStatusComments(
    options,
    startCleanupScopes(options),
    options.transientComments,
  );
}

export async function publishStageStartComment(
  options: Omit<StagePublishingOptions, "parsedOutput">,
): Promise<PublishedArtifactComment | undefined> {
  await cleanupTransientStatusComments(options, startCleanupScopes(options));
  const body = renderStageStartComment({
    context: options.context,
    stage: options.runner.stage,
    workflowRunUrl: options.runner.workflowRunUrl,
  });
  return publishArtifactComment({ ...options, body });
}

export async function applyStageLabelTransition(options: StagePublishingOptions): Promise<void> {
  if (options.context.artifact.type === "discussion") return;
  if (shouldBlockInvestigation(options)) {
    await addIssueLabel({
      client: options.client,
      issueNumber: options.context.artifact.number,
      label: gitVibeLabels.blocked.name,
      repository: options.runner.repository,
      token: options.runner.token,
    });
    await removeIssueLabel({
      client: options.client,
      issueNumber: options.context.artifact.number,
      label: gitVibeLabels.approved.name,
      logger: options.logger,
      repository: options.runner.repository,
      token: options.runner.token,
    });
    return;
  }

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

async function publishArtifactComment(
  options: ArtifactCommentOptions,
): Promise<PublishedArtifactComment | undefined> {
  const artifact = options.context.artifact;
  if (artifact.type === "discussion") {
    return publishDiscussionComment(options);
  }

  if (artifact.type === "pull-request" && isPullRequestReviewReply(options.runner.sourceComment)) {
    return publishPullRequestReviewReply(options);
  }

  options.logger.event("github.issue.comment.start", {
    artifact: `${artifact.type}#${artifact.number}`,
    source_comment_kind: options.runner.sourceComment?.kind || "",
  });
  const comment = await createIssueComment({
    body: flatReplyBody(options.body, options.runner.sourceComment),
    client: options.client,
    issueNumber: artifact.number,
    repository: options.runner.repository,
    token: options.runner.token,
  });
  options.logger.event("github.issue.comment.done", {
    artifact: `${artifact.type}#${artifact.number}`,
  });
  return comment;
}

async function publishDiscussionComment(
  options: ArtifactCommentOptions,
): Promise<PublishedArtifactComment | undefined> {
  const artifact = options.context.artifact;
  if (!artifact.id) {
    options.logger.event("github.discussion.comment.skip", {
      discussion: artifact.number,
      reason: "missing-discussion-id",
    });
    return undefined;
  }

  options.logger.event("github.discussion.comment.start", {
    discussion: artifact.number,
    reply_to: discussionReplyToId(options.runner, options.context) || "",
  });
  const comment = await addDiscussionComment({
    body: options.body,
    client: options.client,
    discussionId: artifact.id,
    replyToId: discussionReplyToId(options.runner, options.context),
    token: options.runner.token,
  });
  options.logger.event("github.discussion.comment.done", { discussion: artifact.number });
  return { id: comment.id, surface: "discussion-comment" };
}

async function publishPullRequestReviewReply(
  options: ArtifactCommentOptions,
): Promise<PublishedArtifactComment | undefined> {
  const commentId = options.runner.sourceComment?.id || "";
  const artifact = options.context.artifact;
  const { owner, repo } = splitRepository(options.runner.repository);

  options.logger.event("github.pr.review_comment.reply.start", {
    comment: commentId,
    pull_request: artifact.number,
  });
  const comment = await options.client.request<{ id?: number | string }>({
    body: { body: options.body },
    method: "POST",
    path: `/repos/${owner}/${repo}/pulls/${artifact.number}/comments/${commentId}/replies`,
    token: options.runner.token,
  });
  options.logger.event("github.pr.review_comment.reply.done", {
    comment: commentId,
    pull_request: artifact.number,
  });
  return publishedComment("pull-request-review-comment", comment.id);
}

async function createIssueComment(options: {
  body: string;
  client: GitHubClient;
  issueNumber: string;
  repository: string;
  token: string;
}): Promise<PublishedArtifactComment | undefined> {
  const { owner, repo } = splitRepository(options.repository);
  const comment = await options.client.request<{ id?: number | string }>({
    body: { body: options.body },
    method: "POST",
    path: `/repos/${owner}/${repo}/issues/${options.issueNumber}/comments`,
    token: options.token,
  });
  return publishedComment("issue-comment", comment.id);
}

async function cleanupTransientStatusComments(
  options: Omit<StagePublishingOptions, "parsedOutput">,
  scopes: TransientStatusScope[],
  extraRefs: PublishedArtifactComment[] = [],
): Promise<void> {
  const refs = uniqueCommentRefs([
    ...extraRefs,
    ...transientRefsFromContext(options.context, scopes),
    ...staleTransientRefsFromContext(options.context),
  ]);
  await Promise.all(refs.map((ref) => deleteTransientStatusComment(options, ref)));
}

function startCleanupScopes(
  options: Omit<StagePublishingOptions, "parsedOutput">,
): TransientStatusScope[] {
  const artifact = options.context.artifact;
  const run = workflowRunIdFromUrl(options.runner.workflowRunUrl);
  return [
    { artifact: artifact.type, kind: "workflow-queued", number: artifact.number, run },
    {
      artifact: artifact.type,
      kind: "stage-start",
      number: artifact.number,
      run,
      stage: options.runner.stage,
    },
  ];
}

function transientRefsFromContext(
  context: ContextPacket,
  scopes: TransientStatusScope[],
): PublishedArtifactComment[] {
  return context.timeline.flatMap((item) => {
    const marker = parseTransientStatusMarker(item.body);
    if (!scopes.some((scope) => matchesTransientStatusScope(marker, scope))) return [];
    const ref = publishedComment(
      surfaceForTimelineItem(context.artifact.type, item.kind),
      refId(item),
    );
    return ref ? [ref] : [];
  });
}

function staleTransientRefsFromContext(context: ContextPacket): PublishedArtifactComment[] {
  const nowMs = Date.now();
  return context.timeline.flatMap((item) => {
    const marker = parseTransientStatusMarker(item.body);
    if (!marker) return [];
    if (marker.artifact !== context.artifact.type || marker.number !== context.artifact.number) {
      return [];
    }
    if (!isStaleTimelineItem(item.createdAt, nowMs)) return [];
    const ref = publishedComment(
      surfaceForTimelineItem(context.artifact.type, item.kind),
      refId(item),
    );
    return ref ? [ref] : [];
  });
}

function isStaleTimelineItem(createdAt: string | undefined, nowMs: number): boolean {
  const createdAtMs = Date.parse(String(createdAt || ""));
  return Number.isFinite(createdAtMs) && nowMs - createdAtMs >= staleTransientStatusCommentAgeMs;
}

async function deleteTransientStatusComment(
  options: Omit<StagePublishingOptions, "parsedOutput">,
  ref: PublishedArtifactComment,
): Promise<void> {
  try {
    await deleteCommentRef(options, ref);
    options.logger.event("github.status_comment.delete.done", {
      artifact: `${options.context.artifact.type}#${options.context.artifact.number}`,
      surface: ref.surface,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) return;
    options.logger.event("github.status_comment.delete.failed", {
      artifact: `${options.context.artifact.type}#${options.context.artifact.number}`,
      error: error instanceof Error ? error.message : String(error),
      surface: ref.surface,
    });
  }
}

async function deleteCommentRef(
  options: Omit<StagePublishingOptions, "parsedOutput">,
  ref: PublishedArtifactComment,
): Promise<void> {
  if (ref.surface === "discussion-comment") {
    await deleteDiscussionComment({
      client: options.client,
      commentId: ref.id,
      token: options.runner.token,
    });
    return;
  }

  const { owner, repo } = splitRepository(options.runner.repository);
  const path =
    ref.surface === "pull-request-review-comment"
      ? `/repos/${owner}/${repo}/pulls/comments/${ref.id}`
      : `/repos/${owner}/${repo}/issues/comments/${ref.id}`;
  await options.client.request({ method: "DELETE", path, token: options.runner.token });
}

function surfaceForTimelineItem(
  artifact: ContextPacket["artifact"]["type"],
  kind: string,
): PublishedArtifactComment["surface"] {
  if (artifact === "discussion") return "discussion-comment";
  if (kind === "pull-request-review-comment") return "pull-request-review-comment";
  return "issue-comment";
}

function refId(item: { databaseId?: number | string; id: string; kind: string }): string {
  if (item.kind === "pull-request-review-comment" && item.databaseId) {
    return String(item.databaseId);
  }
  return item.id;
}

function uniqueCommentRefs(refs: PublishedArtifactComment[]): PublishedArtifactComment[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.surface}:${ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function publishedComment(
  surface: PublishedArtifactComment["surface"],
  id: number | string | undefined,
): PublishedArtifactComment | undefined {
  const value = id === undefined || id === null ? "" : String(id).trim();
  return value ? { id: value, surface } : undefined;
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

async function removeIssueLabel(options: {
  client: GitHubClient;
  issueNumber: string;
  label: string;
  logger: StageLogger;
  repository: string;
  token: string;
}): Promise<void> {
  const { owner, repo } = splitRepository(options.repository);
  try {
    await options.client.request({
      method: "DELETE",
      path: `/repos/${owner}/${repo}/issues/${options.issueNumber}/labels/${encodeURIComponent(options.label)}`,
      token: options.token,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) return;
    options.logger.event("github.issue.label.remove.failed", {
      error: error instanceof Error ? error.message : String(error),
      issue: options.issueNumber,
      label: options.label,
    });
    throw error;
  }
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

function shouldBlockInvestigation(options: StagePublishingOptions): boolean {
  return (
    options.runner.stage === "investigate" &&
    options.runner.failOnNotReady === true &&
    !isInvestigationReady(options.parsedOutput)
  );
}

export function isInvestigationReady(output: JsonObject): boolean {
  return (
    normalizedState(output.status || "completed") === "completed" &&
    normalizedState(output.next_state) === "ready-for-implementation" &&
    arrayField(output.blocking_questions).length === 0 &&
    arrayField(output.implementation_plan).length > 0
  );
}

function normalizedState(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-")
    .replace(/\s+/g, "-");
}

function arrayField(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
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
  return (
    state === "ready" ||
    state.endsWith(":ready") ||
    state === "ready-for-implementation" ||
    state.includes("ready-for-approval")
  );
}
