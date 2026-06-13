import {
  acceptedRiskArtifactContentSha,
  appendAcceptedRiskMetadataBlock,
  type AcceptedRiskMetadata,
} from "../shared/accepted-risk.js";
import {
  discussionComments,
  discussionContent,
  updateDiscussionComment,
} from "../shared/discussions.js";
import { paginatedGitHubRequest } from "../shared/github.js";
import {
  parseStageResultMarker,
  stageResultStatus,
  type StageResultMarker,
} from "../shared/stage-result-markers.js";
import { workflowRunIdFromUrl } from "../shared/status-comments.js";
import type { Stage } from "../shared/types.js";
import {
  createDiscussionComment,
  createIssueComment,
  dispatchWorkflow,
  issueComments,
  postQueuedWorkflowComment,
  repositoryWorkflowBudgetInputs,
  removeDiscussionLabelFromPayload,
  type WebhookActionContext,
} from "./server-actions.js";
import { removeIssueLabel } from "./labels.js";

interface StageResult {
  marker: StageResultMarker;
  order: number;
  source: StageResultSource;
  status: string;
  time: number;
}

const trustedAutomationAuthors = new Set(["gitvibe-for-github[bot]"]);

interface PullRequestReviewResponse {
  author_association?: string;
  body?: string | null;
  id?: number | string;
  submitted_at?: string;
  user?: { login?: string };
}

interface PullRequestResponse extends Record<string, unknown> {
  body?: string | null;
  head?: { sha?: string };
  title?: string;
}

interface ArtifactContentResponse extends Record<string, unknown> {
  body?: string | null;
  title?: string;
}

interface IssueCommentResponse {
  author_association?: string;
  body?: string | null;
  created_at?: string;
  id?: number | string;
  user?: { login?: string };
}

interface StageResultSource {
  author?: string;
  authorAssociation?: string;
  body?: string | null;
  createdAt?: string;
  id?: string;
  order: number;
  surface: "discussion-comment" | "issue-comment" | "pull-request-review";
}

interface ResumePlan {
  artifact: "discussion" | "issue" | "pull-request";
  inputName: "discussion-number" | "issue-number" | "pr-number";
  number: string;
  riskStages: Stage[];
  workflow: string;
}

interface AcceptedRiskWorkflowDispatch extends Record<string, unknown> {
  html_url?: string;
  ref: string;
  run_url?: string;
  workflow_run_id?: number | string;
}

export async function handleAcceptRiskLabel(
  options: WebhookActionContext,
  label: string,
): Promise<void> {
  const result = await latestTrustedStageResult(options);
  if (!result || result.status !== "blocked") {
    await removeAcceptRiskLabel(options, label);
    await postAcceptRiskNoopComment(
      options,
      `GitVibe removed \`${label}\` because no valid blocked GitVibe stage result was found on this artifact.`,
    );
    return;
  }

  const plan = resumePlanFor(options, result.marker);
  if (!plan) {
    await removeAcceptRiskLabel(options, label);
    await postAcceptRiskNoopComment(
      options,
      `GitVibe removed \`${label}\` because blocked stage \`${result.marker.stage}\` cannot be resumed from this artifact.`,
    );
    return;
  }

  const acceptance = await acceptedRiskMetadata(options, plan, result.marker.stage);
  const dispatch = await dispatchAcceptedRiskWorkflow(options, label, plan);
  if (!dispatch) return;

  const run = workflowRunIdFromDispatch(dispatch);
  if (!run) {
    await removeAcceptRiskLabel(options, label);
    await postAcceptRiskNoopComment(
      options,
      `GitVibe removed \`${label}\` because GitHub did not return a workflow run id for the accepted-risk rerun. Apply the label again after GitHub workflow dispatch run details are available.`,
    );
    return;
  }

  const boundAcceptance = { ...acceptance, run };
  const stored = await storeRunBoundAcceptedRisk(options, label, result, plan, boundAcceptance);
  if (!stored) return;

  await removeAcceptRiskLabel(options, label);
  await postQueuedWorkflowComment(options, {
    artifact: plan.artifact,
    number: plan.number,
    reason: `accepted prompt-injection risk for \`${result.marker.stage}\` from \`${label}\` label`,
    workflow: plan.workflow,
    ref: dispatch.ref,
    workflowRunUrl: dispatch.html_url,
  });
}

async function dispatchAcceptedRiskWorkflow(
  options: WebhookActionContext,
  label: string,
  plan: ResumePlan,
): Promise<AcceptedRiskWorkflowDispatch | undefined> {
  try {
    return await dispatchWorkflow(options, plan.workflow, {
      ...(await repositoryWorkflowBudgetInputs(options, plan.workflow)),
      [plan.inputName]: plan.number,
    });
  } catch (error) {
    await removeAcceptRiskLabel(options, label);
    options.log(`accepted-risk workflow dispatch failed: ${errorSummary(error)}`);
    await postAcceptRiskNoopComment(
      options,
      `GitVibe removed \`${label}\` because it could not queue a run-bound accepted-risk workflow.`,
    );
    return undefined;
  }
}

async function storeRunBoundAcceptedRisk(
  options: WebhookActionContext,
  label: string,
  result: StageResult,
  plan: ResumePlan,
  acceptance: AcceptedRiskMetadata,
): Promise<boolean> {
  try {
    await updateAcceptedRiskResultComment(options, result.source, plan, acceptance);
    return true;
  } catch (error) {
    await removeAcceptRiskLabel(options, label);
    options.log(`accepted-risk metadata update failed: ${errorSummary(error)}`);
    await postAcceptRiskNoopComment(
      options,
      `GitVibe removed \`${label}\` because it could not record run-bound accepted-risk metadata.`,
    );
    return false;
  }
}

function workflowRunIdFromDispatch(dispatch: AcceptedRiskWorkflowDispatch): string {
  return (
    stringValue(dispatch.workflow_run_id) ||
    workflowRunIdFromUrl(dispatch.html_url) ||
    workflowRunIdFromUrl(dispatch.run_url) ||
    ""
  );
}

async function latestTrustedStageResult(
  options: WebhookActionContext,
): Promise<StageResult | undefined> {
  const artifact = artifactForPayload(options);
  if (!artifact) return undefined;
  const sources = await stageResultSources(options, artifact);
  const candidates = sources
    .map((source) => stageResultFromSource(source, artifact))
    .filter((result): result is StageResult => Boolean(result));
  return candidates.sort(compareStageResults).at(-1);
}

function stageResultFromSource(
  source: StageResultSource,
  artifact: Pick<StageResultMarker, "artifact" | "number">,
): StageResult | undefined {
  const marker = parseStageResultMarker(source.body);
  if (!marker || marker.artifact !== artifact.artifact || marker.number !== artifact.number) {
    return undefined;
  }
  if (!trustedStageResultAuthor(source)) return undefined;
  return {
    marker,
    order: source.order,
    source,
    status: stageResultStatus(source.body),
    time: sourceTime(source.createdAt),
  };
}

async function stageResultSources(
  options: WebhookActionContext,
  artifact: Pick<StageResultMarker, "artifact" | "number">,
): Promise<StageResultSource[]> {
  if (artifact.artifact === "discussion") return discussionStageResultSources(options);
  const comments = (await issueComments(options, artifact.number)).map((comment, index) => {
    const value = comment as IssueCommentResponse;
    return {
      author: userLogin(value),
      authorAssociation: stringField(value.author_association),
      body: value.body,
      createdAt: stringField(value.created_at),
      id: stringValue(value.id),
      order: index,
      surface: "issue-comment" as const,
    };
  });
  if (artifact.artifact !== "pull-request") return comments;
  const reviews = (await pullRequestReviews(options, artifact.number)).map((review, index) => ({
    author: userLogin(review),
    authorAssociation: stringField(review.author_association),
    body: review.body,
    createdAt: stringField(review.submitted_at),
    id: stringValue(review.id),
    order: comments.length + index,
    surface: "pull-request-review" as const,
  }));
  return [...comments, ...reviews];
}

async function discussionStageResultSources(
  options: WebhookActionContext,
): Promise<StageResultSource[]> {
  const discussionId = discussionNodeId(options);
  if (!discussionId) return [];
  const comments = await discussionComments({
    client: options.client,
    discussionId,
    token: options.token,
  });
  return comments.map((comment, index) => ({
    author: userLogin(comment),
    authorAssociation: stringField(comment.authorAssociation),
    body: comment.body,
    createdAt: stringField(comment.createdAt),
    id: stringField(comment.id),
    order: index,
    surface: "discussion-comment" as const,
  }));
}

async function pullRequestReviews(
  options: WebhookActionContext,
  prNumber: string,
): Promise<PullRequestReviewResponse[]> {
  return paginatedGitHubRequest<PullRequestReviewResponse>(options.client, {
    method: "GET",
    path: `/repos/${options.owner}/${options.repo}/pulls/${prNumber}/reviews`,
    token: options.token,
  });
}

function resumePlanFor(
  options: WebhookActionContext,
  marker: StageResultMarker,
): ResumePlan | undefined {
  const number = marker.number;
  if (marker.artifact === "discussion") {
    if (marker.stage === "validate") {
      return {
        artifact: "discussion",
        inputName: "discussion-number",
        number,
        riskStages: [marker.stage],
        workflow: "validate.yml",
      };
    }
    if (marker.stage === "materialize") {
      return {
        artifact: "discussion",
        inputName: "discussion-number",
        number,
        riskStages: [marker.stage],
        workflow: "materialize.yml",
      };
    }
    return undefined;
  }
  if (marker.artifact === "pull-request") return pullRequestResumePlan(marker);
  return issueResumePlan(marker);
}

function issueResumePlan(marker: StageResultMarker): ResumePlan | undefined {
  const number = marker.number;
  if (marker.stage === "investigate") {
    return {
      artifact: "issue",
      inputName: "issue-number",
      number,
      riskStages: [marker.stage],
      workflow: "investigate.yml",
    };
  }
  if (marker.stage === "validate") {
    return {
      artifact: "issue",
      inputName: "issue-number",
      number,
      riskStages: [marker.stage],
      workflow: "validate.yml",
    };
  }
  if (marker.stage === "implement" || marker.stage === "create-pr") {
    return {
      artifact: "issue",
      inputName: "issue-number",
      number,
      riskStages: ["implement", "create-pr"],
      workflow: "develop.yml",
    };
  }
  return undefined;
}

function pullRequestResumePlan(marker: StageResultMarker): ResumePlan | undefined {
  const number = marker.number;
  if (marker.stage === "review-matrix") {
    return {
      artifact: "pull-request",
      inputName: "pr-number",
      number,
      riskStages: [marker.stage],
      workflow: "review.yml",
    };
  }
  if (marker.stage === "investigate" || marker.stage === "address-pr-feedback") {
    return {
      artifact: "pull-request",
      inputName: "pr-number",
      number,
      riskStages: ["investigate", "address-pr-feedback"],
      workflow: "address-feedback.yml",
    };
  }
  return undefined;
}

async function acceptedRiskArtifactSha(
  options: WebhookActionContext,
  plan: ResumePlan,
): Promise<string> {
  if (plan.artifact !== "pull-request") return "";
  const payloadSha = stringField(options.payload.pull_request?.head?.sha);
  if (payloadSha) return payloadSha;
  const pullRequest = await options.client.request<PullRequestResponse>({
    method: "GET",
    path: `/repos/${options.owner}/${options.repo}/pulls/${plan.number}`,
    token: options.token,
  });
  return stringField(pullRequest.head?.sha);
}

async function acceptedRiskMetadata(
  options: WebhookActionContext,
  plan: ResumePlan,
  stage: Stage,
): Promise<AcceptedRiskMetadata> {
  const [artifactSha, content] = await Promise.all([
    acceptedRiskArtifactSha(options, plan),
    acceptedRiskArtifactContent(options, plan),
  ]);
  return {
    actor: options.payload.sender?.login || undefined,
    artifact: plan.artifact,
    artifactContentSha: acceptedRiskArtifactContentSha(content),
    artifactSha: artifactSha || undefined,
    cutoff: new Date().toISOString(),
    number: plan.number,
    stage,
    stages: plan.riskStages,
  };
}

async function acceptedRiskArtifactContent(
  options: WebhookActionContext,
  plan: ResumePlan,
): Promise<ArtifactContentResponse> {
  const payloadContent = payloadArtifactContent(options, plan.artifact);
  if (payloadContent) return payloadContent;
  if (plan.artifact === "discussion") {
    const content = await discussionContent({
      client: options.client,
      discussionNumber: plan.number,
      repository: `${options.owner}/${options.repo}`,
      token: options.token,
    });
    return { body: content.body, title: content.title };
  }
  return options.client.request<ArtifactContentResponse>({
    method: "GET",
    path: `/repos/${options.owner}/${options.repo}/${plan.artifact === "pull-request" ? "pulls" : "issues"}/${plan.number}`,
    token: options.token,
  });
}

function payloadArtifactContent(
  options: WebhookActionContext,
  artifact: ResumePlan["artifact"],
): ArtifactContentResponse | undefined {
  if (artifact === "discussion" && hasArtifactContent(options.payload.discussion)) {
    return options.payload.discussion;
  }
  if (artifact === "pull-request" && hasArtifactContent(options.payload.pull_request)) {
    return options.payload.pull_request;
  }
  if (hasArtifactContent(options.payload.issue)) return options.payload.issue;
  return undefined;
}

async function updateAcceptedRiskResultComment(
  options: WebhookActionContext,
  source: StageResultSource,
  plan: ResumePlan,
  metadata: AcceptedRiskMetadata,
): Promise<void> {
  if (!source.id)
    throw new Error("Cannot update accepted-risk metadata: missing result comment id.");
  const body = appendAcceptedRiskMetadataBlock(String(source.body || ""), metadata);
  if (source.surface === "discussion-comment") {
    await updateDiscussionComment({
      body,
      client: options.client,
      commentId: source.id,
      token: options.token,
    });
    return;
  }
  if (source.surface === "pull-request-review") {
    await updatePullRequestReviewBody(options, plan.number, source.id, body);
    return;
  }
  await updateIssueCommentBody(options, source.id, body);
}

async function updateIssueCommentBody(
  options: WebhookActionContext,
  commentId: string,
  body: string,
): Promise<void> {
  await options.client.request({
    body: { body },
    method: "PATCH",
    path: `/repos/${options.owner}/${options.repo}/issues/comments/${commentId}`,
    token: options.token,
  });
}

async function updatePullRequestReviewBody(
  options: WebhookActionContext,
  prNumber: string,
  reviewId: string,
  body: string,
): Promise<void> {
  await options.client.request({
    body: { body },
    method: "PUT",
    path: `/repos/${options.owner}/${options.repo}/pulls/${prNumber}/reviews/${reviewId}`,
    token: options.token,
  });
}

function artifactForPayload(
  options: WebhookActionContext,
): Pick<StageResultMarker, "artifact" | "number"> | undefined {
  if (options.payload.discussion?.number) {
    return { artifact: "discussion", number: String(options.payload.discussion.number) };
  }
  const number = options.payload.issue?.number || options.payload.pull_request?.number;
  if (!number) return undefined;
  return {
    artifact:
      options.payload.issue?.pull_request || options.payload.pull_request
        ? "pull-request"
        : "issue",
    number: String(number),
  };
}

async function removeAcceptRiskLabel(options: WebhookActionContext, label: string): Promise<void> {
  if (options.payload.discussion) {
    await removeDiscussionLabelFromPayload(options, label);
    return;
  }
  const number = String(
    options.payload.issue?.number || options.payload.pull_request?.number || "",
  );
  if (!number) return;
  await removeIssueLabel({
    client: options.client,
    issueNumber: number,
    label,
    owner: options.owner,
    repo: options.repo,
    token: options.token,
  });
}

async function postAcceptRiskNoopComment(
  options: WebhookActionContext,
  body: string,
): Promise<void> {
  if (options.payload.discussion) {
    await createDiscussionComment(options, body);
    return;
  }
  const number = String(
    options.payload.issue?.number || options.payload.pull_request?.number || "",
  );
  if (number) await createIssueComment(options, number, body);
}

function trustedStageResultAuthor(source: StageResultSource): boolean {
  const association = stringField(source.authorAssociation).toUpperCase();
  if (["COLLABORATOR", "MEMBER", "OWNER"].includes(association)) return true;
  const author = stringField(source.author).toLowerCase();
  return trustedAutomationAuthors.has(author);
}

function compareStageResults(left: StageResult, right: StageResult): number {
  return left.time - right.time || left.order - right.order;
}

function discussionNodeId(options: WebhookActionContext): string {
  const value =
    options.payload.discussion?.node_id ||
    options.payload.discussion?.nodeId ||
    options.payload.discussion?.id;
  return stringField(value);
}

function sourceTime(value: string | undefined): number {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function userLogin(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const user = (value as { author?: { login?: string }; user?: { login?: string } }).user;
  const author = (value as { author?: { login?: string }; user?: { login?: string } }).author;
  return stringField(user?.login || author?.login);
}

function hasArtifactContent(value: unknown): value is ArtifactContentResponse {
  return Boolean(value && typeof value === "object" && ("body" in value || "title" in value));
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  return stringField(value);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function errorSummary(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
