import { gitVibeBaseBranchVariable } from "../shared/config.js";
import {
  addDiscussionComment,
  addDiscussionLabel,
  deleteDiscussionComment,
  discussionComments,
  discussionLabels,
  removeDiscussionLabel,
} from "../shared/discussions.js";
import {
  GitHubClient,
  repositoryActionsVariable,
  repositoryDefaultBranch,
} from "../shared/github.js";
import {
  equivalentGitVibeLabelNames,
  gitVibeInternalLabels,
  gitVibeLabels,
} from "../shared/labels.js";
import { encodeSourceComment } from "../shared/source-comments.js";
import {
  matchesTransientStatusScope,
  parseTransientStatusMarker,
  workflowQueuedMarker,
  workflowRunIdFromUrl,
} from "../shared/status-comments.js";
import {
  gitVibeTraceabilityIssueNumbers,
  pullRequestReviewFixFromBody,
  reviewFixTraceFromBody,
} from "../shared/traceability.js";
import type { SourceComment, SourceCommentKind } from "../shared/types.js";
import type { IntakeComment } from "./intake.js";
import { removeIssueLabel } from "./labels.js";
import type { WebhookPayload } from "./types.js";

export interface WebhookActionContext {
  client: GitHubClient;
  log: (message: string) => void;
  owner: string;
  payload: WebhookPayload;
  repo: string;
  token: string;
}

interface WorkflowDispatchResult extends Record<string, unknown> {
  html_url?: string;
  ref: string;
  run_url?: string;
  workflow_run_id?: number | string;
}

export async function markPullRequestApproved(
  options: WebhookActionContext,
  prNumber: string,
): Promise<void> {
  const sourceIssueNumbers = await sourceIssuesForPullRequest(options, prNumber);
  if (sourceIssueNumbers.length === 0) {
    options.log(`skipped approved review labels for PR #${prNumber}: missing GitVibe traceability`);
    return;
  }

  await markPullRequestApprovalState(options, prNumber);
  await updateSourceIssueLabels(options, sourceIssueNumbers, {
    add: [],
    remove: [gitVibeLabels.approved.name],
    reason: "approved review",
  });
}

export async function markPullRequestMerged(
  options: WebhookActionContext,
  prNumber: string,
): Promise<void> {
  const sourceIssueNumbers = await sourceIssuesForPullRequest(options, prNumber);
  if (sourceIssueNumbers.length === 0) {
    options.log(`skipped merged PR labels for PR #${prNumber}: missing GitVibe traceability`);
    return;
  }

  await markPullRequestApprovalState(options, prNumber);
  await updateSourceIssueLabels(options, sourceIssueNumbers, {
    add: [gitVibeLabels.prMerged.name],
    remove: [
      gitVibeLabels.prOpened.name,
      gitVibeLabels.prApproved.name,
      gitVibeLabels.approved.name,
    ],
    reason: "merged PR",
  });
}

async function markPullRequestApprovalState(
  options: WebhookActionContext,
  prNumber: string,
): Promise<void> {
  for (const label of equivalentGitVibeLabelNames(gitVibeLabels.readyForApproval.name)) {
    await removeIssueLabelIfPresent(options, prNumber, label);
  }
  await addIssueLabel(options, prNumber, gitVibeLabels.prApproved.name);
}

export async function dispatchWorkflow(
  options: WebhookActionContext,
  workflow: string,
  inputs: Record<string, string>,
): Promise<WorkflowDispatchResult> {
  const ref = await workflowDispatchRef(options);
  const body = {
    inputs,
    ref,
    return_run_details: true,
  };
  try {
    const dispatch = await options.client.request<WorkflowDispatchResult>({
      apiVersion: "2026-03-10",
      body,
      method: "POST",
      path: `/repos/${options.owner}/${options.repo}/actions/workflows/${workflow}/dispatches`,
      token: options.token,
    });
    return { ...dispatch, ref };
  } catch (error) {
    if (!isDispatchRunDetailsCompatibilityError(error)) throw error;
    options.log(
      `workflow dispatch run details unavailable for ${workflow}: ${summarizeError(error)}`,
    );
  }

  await options.client.request({
    body: { inputs, ref },
    method: "POST",
    path: `/repos/${options.owner}/${options.repo}/actions/workflows/${workflow}/dispatches`,
    token: options.token,
  });
  return { ref };
}

export function commandInputs(
  options: WebhookActionContext,
  inputs: Record<string, string>,
  kind: SourceCommentKind,
): Record<string, string> {
  return {
    ...inputs,
    "source-comment": sourceCommentInput(options, kind),
  };
}

export function sourceReviewInput(options: WebhookActionContext): string {
  const review = options.payload.review;
  if (!review) return "";
  return encodeSourceComment({
    body: review.body,
    id: review.id === undefined ? undefined : String(review.id),
    kind: "pull-request-review",
    nodeId: review.node_id || review.nodeId,
    url: review.html_url || review.url,
  });
}

export async function postQueuedWorkflowComment(
  options: WebhookActionContext,
  comment: QueuedWorkflowComment,
): Promise<void> {
  try {
    await createQueuedWorkflowComment(options, comment);
  } catch (error) {
    options.log(`workflow queued comment failed: ${summarizeError(error)}`);
  }
}

export async function createDiscussionComment(
  options: WebhookActionContext,
  body: string,
): Promise<void> {
  const discussionId = discussionNodeId(options.payload.discussion);
  if (!discussionId) {
    options.log("discussion comment skipped: missing discussion node_id");
    return;
  }
  await addDiscussionComment({
    body,
    client: options.client,
    discussionId,
    token: options.token,
  });
}

export async function removeDiscussionLabelFromPayload(
  options: WebhookActionContext,
  label: string,
): Promise<void> {
  const discussionId = discussionNodeId(options.payload.discussion);
  if (!discussionId) throw new Error("missing discussion node_id for label removal");

  await removeDiscussionLabel({
    client: options.client,
    discussionId,
    label,
    labelId: options.payload.label?.name === label ? labelNodeId(options.payload.label) : undefined,
    repository: `${options.owner}/${options.repo}`,
    token: options.token,
  });
}

export async function addDiscussionLabelFromPayload(
  options: WebhookActionContext,
  label: string,
): Promise<void> {
  const discussionId = discussionNodeId(options.payload.discussion);
  if (!discussionId) throw new Error("missing discussion node_id for label addition");

  await addDiscussionLabel({
    client: options.client,
    discussionId,
    label,
    repository: `${options.owner}/${options.repo}`,
    token: options.token,
  });
}

export async function removeDiscussionLabelBestEffort(
  options: WebhookActionContext,
  label: string,
): Promise<void> {
  try {
    await removeDiscussionLabelFromPayload(options, label);
  } catch (error) {
    options.log(`discussion label cleanup failed for ${label}: ${summarizeError(error)}`);
  }
}

export function commandReason(raw: string): string {
  return `command ${inlineCode(raw)}`;
}

export function labelReason(label: string): string {
  return `${inlineCode(label)} label`;
}

export function issueHasLabel(issue: WebhookPayload["issue"], label: string): boolean {
  const labelNames = new Set(equivalentGitVibeLabelNames(label));
  return Boolean(issue?.labels?.some((item) => item.name && labelNames.has(item.name)));
}

export async function discussionHasLabel(
  options: WebhookActionContext,
  label: string,
): Promise<boolean> {
  const labelNames = new Set(equivalentGitVibeLabelNames(label));
  if (discussionPayloadLabels(options.payload.discussion).some((name) => labelNames.has(name))) {
    return true;
  }

  const discussionId = discussionNodeId(options.payload.discussion);
  if (!discussionId) return false;
  const labels = await discussionLabels({
    client: options.client,
    discussionId,
    token: options.token,
  });
  return labels.some((name) => labelNames.has(name));
}

export async function acknowledgeCommand(options: WebhookActionContext): Promise<boolean> {
  const subjectId = commandCommentNodeId(options.payload.comment);
  if (!subjectId) {
    options.log("command acknowledgement skipped: missing comment node_id");
    return false;
  }

  try {
    await options.client.graphql(
      addReactionMutation,
      { content: "ROCKET", subjectId },
      options.token,
    );
    return true;
  } catch (error) {
    options.log(`command acknowledgement failed: ${summarizeError(error)}`);
    return false;
  }
}

export async function createIssueComment(
  options: WebhookActionContext,
  issueNumber: string,
  body: string,
): Promise<void> {
  await options.client.request({
    body: { body },
    method: "POST",
    path: `/repos/${options.owner}/${options.repo}/issues/${issueNumber}/comments`,
    token: options.token,
  });
}

export async function issueComments(
  options: WebhookActionContext,
  issueNumber: string,
): Promise<IntakeComment[]> {
  return options.client.request<IntakeComment[]>({
    method: "GET",
    path: `/repos/${options.owner}/${options.repo}/issues/${issueNumber}/comments?per_page=100`,
    token: options.token,
  });
}

export async function closeIssue(
  options: WebhookActionContext,
  issueNumber: string,
): Promise<void> {
  await options.client.request({
    body: { state: "closed", state_reason: "completed" },
    method: "PATCH",
    path: `/repos/${options.owner}/${options.repo}/issues/${issueNumber}`,
    token: options.token,
  });
}

export async function addIssueLabel(
  options: WebhookActionContext,
  issueNumber: string,
  label: string,
): Promise<void> {
  await options.client.request({
    body: { labels: [label] },
    method: "POST",
    path: `/repos/${options.owner}/${options.repo}/issues/${issueNumber}/labels`,
    token: options.token,
  });
}

export async function removeIssueLabelIfPresent(
  options: WebhookActionContext,
  issueNumber: string,
  label: string,
): Promise<void> {
  try {
    await removeIssueLabel({
      client: options.client,
      issueNumber,
      label,
      owner: options.owner,
      repo: options.repo,
      token: options.token,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) return;
    throw error;
  }
}

export async function removeEquivalentIssueLabelIfPresent(
  options: WebhookActionContext,
  issueNumber: string,
  label: string,
): Promise<void> {
  for (const equivalentLabel of equivalentGitVibeLabelNames(label)) {
    await removeIssueLabelIfPresent(options, issueNumber, equivalentLabel);
  }
}

export async function handleManagedReviewFixLabel(
  options: WebhookActionContext,
  issueNumber: string,
): Promise<void> {
  const label = gitVibeInternalLabels.reviewFix.name;
  if (await hasManagedReviewFixMarker(options, issueNumber)) {
    const subject = options.payload.issue?.pull_request ? "PR" : "issue";
    options.log(`accepted managed internal review-fix label on ${subject} #${issueNumber}`);
    return;
  }

  await removeIssueLabel({
    client: options.client,
    issueNumber,
    label,
    owner: options.owner,
    repo: options.repo,
    token: options.token,
  });
  await createIssueComment(options, issueNumber, internalLabelRejectionBody(label));
}

async function hasManagedReviewFixMarker(
  options: WebhookActionContext,
  issueNumber: string,
): Promise<boolean> {
  if (!options.payload.issue?.pull_request) {
    return Boolean(reviewFixTraceFromBody(options.payload.issue?.body || ""));
  }

  const comments = await issueComments(options, issueNumber);
  return comments.some(
    (comment) => pullRequestReviewFixFromBody(comment.body || "")?.pullRequest === issueNumber,
  );
}

export function commandWorkflow(command: string): string | null {
  if (command === "investigate") return "investigate.yml";
  return null;
}

export function protectedLabelRejectionBody(options: WebhookActionContext, label: string): string {
  return `GitVibe removed \`${label}\` because @${options.payload.sender?.login || "<missing>"} is not allowed to control GitVibe automation labels for this repository.`;
}

export function internalLabelRejectionBody(label: string): string {
  return `GitVibe removed \`${label}\` because \`gvi:\` labels are internal runtime labels and must only be applied by GitVibe with a valid hidden marker.`;
}

export function approvalRequiresInvestigationBody(label: string): string {
  return `GitVibe removed \`${label}\` because this issue has not completed investigation yet. Add \`${gitVibeLabels.investigate.name}\` first; GitVibe will replace it with \`${gitVibeLabels.investigating.name}\` and then \`${gitVibeLabels.investigated.name}\` when the investigation is ready for implementation.`;
}

export function approvalRequiresDecompositionBody(label: string): string {
  return `GitVibe removed \`${label}\` because this discussion has not completed decomposition yet. Add \`${gitVibeLabels.decompose.name}\` after validation; GitVibe will replace it with \`${gitVibeLabels.decomposing.name}\` and then \`${gitVibeLabels.decomposed.name}\` when the decomposition is ready for materialization.`;
}

export function decomposeRequiresValidationBody(label: string): string {
  return `GitVibe removed \`${label}\` because this discussion has not completed validation yet. Add \`${gitVibeLabels.validate.name}\` first; GitVibe will replace it with \`${gitVibeLabels.validating.name}\` and then \`${gitVibeLabels.validated.name}\` when validation is ready for decomposition.`;
}

async function updateSourceIssueLabels(
  options: WebhookActionContext,
  issueNumbers: string[],
  change: { add: string[]; reason: string; remove: string[] },
): Promise<void> {
  for (const issueNumber of issueNumbers) {
    for (const label of change.add) {
      await addIssueLabel(options, issueNumber, label);
    }
    for (const label of change.remove) {
      for (const equivalentLabel of equivalentGitVibeLabelNames(label)) {
        await removeIssueLabelIfPresent(options, issueNumber, equivalentLabel);
      }
    }
  }
}

async function sourceIssuesForPullRequest(
  options: WebhookActionContext,
  prNumber: string,
): Promise<string[]> {
  const body = await pullRequestBody(options, prNumber);
  return gitVibeTraceabilityIssueNumbers(body);
}

async function pullRequestBody(options: WebhookActionContext, prNumber: string): Promise<string> {
  if (typeof options.payload.pull_request?.body === "string") {
    return options.payload.pull_request.body;
  }

  const pullRequest = await options.client.request<{ body?: string | null }>({
    method: "GET",
    path: `/repos/${options.owner}/${options.repo}/pulls/${prNumber}`,
    token: options.token,
  });
  return pullRequest.body || "";
}

async function workflowDispatchRef(options: WebhookActionContext): Promise<string> {
  const configured = await repositoryActionsVariable({
    client: options.client,
    name: gitVibeBaseBranchVariable,
    owner: options.owner,
    repo: options.repo,
    token: options.token,
  });
  if (configured) return configured;
  return repositoryDefaultBranch({
    client: options.client,
    owner: options.owner,
    repo: options.repo,
    token: options.token,
  });
}

function sourceCommentInput(options: WebhookActionContext, kind: SourceCommentKind): string {
  return encodeSourceComment(sourceCommentFromPayload(options.payload.comment, kind));
}

function sourceCommentFromPayload(
  comment: WebhookPayload["comment"],
  kind: SourceCommentKind,
): SourceComment | undefined {
  if (!comment) return undefined;
  return {
    body: comment.body,
    id: comment.id === undefined ? undefined : String(comment.id),
    kind,
    nodeId: commandCommentNodeId(comment),
    url: comment.html_url || comment.url,
  };
}

function discussionPayloadLabels(discussion: WebhookPayload["discussion"]): string[] {
  return (discussion?.labels || []).flatMap((label) => {
    const name = label.name?.trim();
    return name ? [name] : [];
  });
}

interface QueuedWorkflowComment {
  artifact: "issue" | "pull-request" | "discussion";
  number: string;
  ref: string;
  reason: string;
  workflow: string;
  workflowRunUrl?: string;
}

async function createQueuedWorkflowComment(
  options: WebhookActionContext,
  comment: QueuedWorkflowComment,
): Promise<void> {
  await cleanupQueuedWorkflowComments(options, comment);
  const body = queuedWorkflowComment(comment);
  if (comment.artifact === "discussion") {
    await createDiscussionComment(options, body);
    return;
  }
  await createIssueComment(options, comment.number, body);
}

async function cleanupQueuedWorkflowComments(
  options: WebhookActionContext,
  comment: QueuedWorkflowComment,
): Promise<void> {
  try {
    if (comment.artifact === "discussion") {
      await cleanupQueuedDiscussionComments(options, comment);
      return;
    }
    await cleanupQueuedIssueComments(options, comment);
  } catch (error) {
    options.log(`workflow queued comment cleanup failed: ${summarizeError(error)}`);
  }
}

async function cleanupQueuedIssueComments(
  options: WebhookActionContext,
  comment: QueuedWorkflowComment,
): Promise<void> {
  const comments = await issueComments(options, comment.number);
  await Promise.all(
    comments
      .filter((candidate) => queuedWorkflowCommentMatches(candidate.body, comment))
      .map((candidate) => deleteIssueComment(options, String(candidate.id || ""))),
  );
}

async function cleanupQueuedDiscussionComments(
  options: WebhookActionContext,
  comment: QueuedWorkflowComment,
): Promise<void> {
  const discussionId = discussionNodeId(options.payload.discussion);
  if (!discussionId) return;
  const comments = await discussionComments({
    client: options.client,
    discussionId,
    token: options.token,
  });
  await Promise.all(
    comments
      .filter((candidate) => queuedWorkflowCommentMatches(candidate.body, comment))
      .map((candidate) =>
        deleteDiscussionComment({
          client: options.client,
          commentId: candidate.id,
          token: options.token,
        }),
      ),
  );
}

function queuedWorkflowCommentMatches(
  body: string | null | undefined,
  comment: QueuedWorkflowComment,
): boolean {
  return matchesTransientStatusScope(parseTransientStatusMarker(body), {
    artifact: comment.artifact,
    kind: "workflow-queued",
    number: comment.number,
    workflow: comment.workflow,
  });
}

function discussionNodeId(discussion: WebhookPayload["discussion"]): string {
  const subjectId = discussion?.node_id || discussion?.nodeId || discussion?.id;
  return typeof subjectId === "string" ? subjectId : "";
}

function labelNodeId(label: WebhookPayload["label"]): string | undefined {
  const labelId = label?.node_id || label?.nodeId || label?.id;
  return typeof labelId === "string" ? labelId : undefined;
}

function queuedWorkflowComment(options: QueuedWorkflowComment): string {
  const run = workflowRunIdFromUrl(options.workflowRunUrl);
  const lines = [
    workflowQueuedMarker({
      artifact: options.artifact,
      number: options.number,
      run,
      workflow: options.workflow,
    }),
    "## GitVibe Workflow Queued",
    "",
    `GitVibe queued ${inlineCode(options.workflow)} on ${inlineCode(options.ref)} for ${options.artifact} #${options.number} from ${options.reason}.`,
  ];
  if (options.workflowRunUrl) lines.push("", `Workflow run: ${options.workflowRunUrl}`);
  lines.push("The runner will post again when the stage starts.");
  return lines.join("\n");
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "'")}\``;
}

function commandCommentNodeId(comment: WebhookPayload["comment"]): string {
  const subjectId = comment?.node_id || comment?.nodeId;
  return typeof subjectId === "string" ? subjectId : "";
}

async function deleteIssueComment(options: WebhookActionContext, commentId: string): Promise<void> {
  if (!commentId) return;
  await options.client.request({
    method: "DELETE",
    path: `/repos/${options.owner}/${options.repo}/issues/comments/${commentId}`,
    token: options.token,
  });
}

function isDispatchRunDetailsCompatibilityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("return_run_details") || message.includes("not a permitted key");
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const addReactionMutation = /* GraphQL */ `
  mutation GitVibeAddReaction($content: ReactionContent!, $subjectId: ID!) {
    addReaction(input: { content: $content, subjectId: $subjectId }) {
      reaction {
        content
      }
    }
  }
`;
