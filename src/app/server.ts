#!/usr/bin/env node

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  addDiscussionComment,
  checkRepositoryDiscussions,
  createRepositoryDiscussion,
  removeDiscussionLabel,
} from "../shared/discussions.js";
import { GitHubClient, splitRepository } from "../shared/github.js";
import { gitVibeInternalLabels, gitVibeLabels, isInternalGitVibeLabel } from "../shared/labels.js";
import { encodeSourceComment } from "../shared/source-comments.js";
import { reviewFixTraceFromBody } from "../shared/traceability.js";
import type { SourceComment, SourceCommentKind } from "../shared/types.js";
import {
  buildDiscussionBody,
  buildDiscussionTitle,
  convertedIssueComment,
  discussionSetupErrorComment,
  hasConversionMarker,
  hasDiscussionSetupMarker,
  isFeatureRequestIssue,
  type IntakeComment,
} from "./intake.js";
import { ensureGitVibeLabels, isProtectedGitVibeLabel, removeIssueLabel } from "./labels.js";
import { parseCommand } from "./commands.js";

export interface WebhookPayload {
  action?: string;
  comment?: {
    body?: string;
    html_url?: string;
    id?: number | string;
    node_id?: string;
    nodeId?: string;
    url?: string;
  };
  discussion?: { id?: string; node_id?: string; nodeId?: string; number?: number | string };
  issue?: {
    body?: string | null;
    html_url?: string;
    labels?: Array<{ name?: string }>;
    number?: number | string;
    pull_request?: unknown;
    title?: string;
    user?: { login?: string };
  };
  label?: { id?: string | number; name?: string; node_id?: string; nodeId?: string };
  pull_request?: { number?: number | string };
  review?: {
    body?: string;
    html_url?: string;
    id?: number | string;
    node_id?: string;
    nodeId?: string;
    state?: string;
    url?: string;
  };
  repository?: { name: string; owner: { login: string } };
  sender?: { login?: string; type?: string };
}

export interface GitVibeApp {
  handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
  handleWebhook(event: string, payload: WebhookPayload): Promise<void>;
  runStartupPreflight(): Promise<void>;
}

export interface GitVibeAppOptions {
  client?: GitHubClient;
  configuredRepository?: string;
  discussionCategory?: string;
  dispatchRef?: string;
  errorLog?: (message: string) => void;
  githubToken: string;
  log?: (message: string) => void;
  webhookSecret: string;
}

interface AppState {
  bootstrappedRepositories: Set<string>;
  client: GitHubClient;
  config: {
    configuredRepository: string;
    discussionCategory: string;
    dispatchRef: string;
    githubToken: string;
    webhookSecret: string;
  };
  errorLog: (message: string) => void;
  log: (message: string) => void;
}

interface WebhookContext extends AppState {
  owner: string;
  payload: WebhookPayload;
  repo: string;
  token: string;
}

export function createGitVibeApp(options: GitVibeAppOptions): GitVibeApp {
  const state: AppState = {
    bootstrappedRepositories: new Set<string>(),
    client: options.client || new GitHubClient(),
    config: {
      configuredRepository: options.configuredRepository || "",
      discussionCategory: options.discussionCategory || "Ideas",
      dispatchRef: options.dispatchRef || "main",
      githubToken: options.githubToken,
      webhookSecret: options.webhookSecret,
    },
    errorLog: options.errorLog || ((message) => console.error(`[git-vibe] ${message}`)),
    log: options.log || ((message) => console.log(`[git-vibe] ${message}`)),
  };

  return {
    handleRequest: (req, res) => handleRequest(state, req, res),
    handleWebhook: (event, payload) => handleWebhook(state, event, payload),
    runStartupPreflight: () => runStartupPreflight(state),
  };
}

export function startServerFromEnv(env: NodeJS.ProcessEnv = process.env): Server {
  const port = Number(env.PORT || 3000);
  const app = createGitVibeApp({
    configuredRepository: env.GITHUB_REPOSITORY || "",
    discussionCategory: env.GITVIBE_DISCUSSION_CATEGORY || "Ideas",
    dispatchRef: env.GITVIBE_DISPATCH_REF || "main",
    githubToken: requiredEnv(env, "GITVIBE_GITHUB_TOKEN"),
    webhookSecret: requiredEnv(env, "GITHUB_WEBHOOK_SECRET"),
  });

  return createServer(app.handleRequest).listen(port, () => {
    console.log(`[git-vibe] app server listening on :${port}`);
    void app.runStartupPreflight();
  });
}

export function isDirectRun(moduleUrl: string, entrypoint = process.argv[1]): boolean {
  if (!moduleUrl) return Boolean(entrypoint && /(?:^|[/\\])server\.(?:c?js|ts)$/.test(entrypoint));
  return Boolean(entrypoint && moduleUrl === pathToFileURL(resolve(entrypoint)).href);
}

async function handleRequest(
  state: AppState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method !== "POST" || req.url !== "/webhooks") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const body = await readBody(req);
    verifyGitHubSignature(
      body,
      firstHeader(req.headers["x-hub-signature-256"]),
      state.config.webhookSecret,
    );
    const event = String(req.headers["x-github-event"] || "");
    const payload = JSON.parse(body) as WebhookPayload;
    await handleWebhook(state, event, payload);
    sendJson(res, 202, { accepted: true, event });
  } catch (error) {
    const httpError = toHttpError(error);
    state.errorLog(`app error: ${httpError.message}`);
    sendJson(res, httpError.statusCode || 500, { error: httpError.message });
  }
}

async function runStartupPreflight(state: AppState): Promise<void> {
  const repository = state.config.configuredRepository;
  if (!repository) {
    state.log(
      "startup preflight skipped: GITHUB_REPOSITORY is unavailable; labels and Discussions will be checked when repository webhooks arrive",
    );
    return;
  }

  try {
    const { owner, repo } = splitRepository(repository);
    await bootstrapRepositoryLabels(state, owner, repo, state.config.githubToken);
  } catch (error) {
    state.errorLog(
      `startup label bootstrap failed for ${repository}: ${summarizeError(error)}. Ensure GITVIBE_GITHUB_TOKEN has Issues write permission.`,
    );
  }

  try {
    const result = await checkRepositoryDiscussions({
      categoryName: state.config.discussionCategory,
      client: state.client,
      repository,
      token: state.config.githubToken,
    });
    logDiscussionPreflightResult(state, result);
  } catch (error) {
    state.errorLog(
      `startup preflight failed: GitHub Discussions unavailable for ${repository}: ${summarizeError(error)}. Enable repository Discussions, create category "${state.config.discussionCategory}", and ensure GITVIBE_GITHUB_TOKEN has Discussions read/write permission.`,
    );
  }
}

function logDiscussionPreflightResult(
  state: AppState,
  result: { categoryName: string; matchedConfiguredCategory: boolean; repository: string },
): void {
  if (result.matchedConfiguredCategory) {
    state.log(
      `startup preflight ok: GitHub Discussions available for ${result.repository} using category "${result.categoryName}"`,
    );
    return;
  }

  state.log(
    `startup preflight warning: GitHub Discussions available for ${result.repository}, but category "${state.config.discussionCategory}" was not found; using "${result.categoryName}"`,
  );
}

async function handleWebhook(
  state: AppState,
  event: string,
  payload: WebhookPayload,
): Promise<void> {
  if (!payload.repository) {
    state.log(`ignored ${event}: missing repository`);
    return;
  }

  const repo = payload.repository.name;
  const owner = payload.repository.owner.login;
  const token = state.config.githubToken;
  await bootstrapRepositoryLabels(state, owner, repo, token);

  if (event === "issues" && payload.action === "opened" && payload.issue) {
    await handleIssueOpened({ ...state, owner, payload, repo, token });
    return;
  }

  if (event === "issue_comment" && payload.action === "created" && payload.issue) {
    await handleIssueComment({ ...state, owner, payload, repo, token });
    return;
  }

  if (event === "discussion_comment" && payload.action === "created" && payload.discussion) {
    await handleDiscussionComment({ ...state, owner, payload, repo, token });
    return;
  }

  if (event === "pull_request_review" && payload.action === "submitted" && payload.pull_request) {
    await handlePullRequestReviewSubmitted({ ...state, owner, payload, repo, token });
    return;
  }

  if (event === "issues" && payload.action === "labeled" && payload.issue) {
    await handleIssueLabeled({ ...state, owner, payload, repo, token });
    return;
  }

  if (event === "discussion" && payload.action === "labeled" && payload.discussion) {
    await handleDiscussionLabeled({ ...state, owner, payload, repo, token });
    return;
  }

  state.log(`ignored ${event}.${payload.action || "unknown"}`);
}

async function bootstrapRepositoryLabels(
  state: AppState,
  owner: string,
  repo: string,
  token: string,
): Promise<void> {
  const key = `${owner}/${repo}`;
  if (state.bootstrappedRepositories.has(key)) return;

  await ensureGitVibeLabels({ client: state.client, owner, repo, token });
  state.bootstrappedRepositories.add(key);
  state.log(`bootstrapped labels for ${key}`);
}

async function handleIssueOpened(options: WebhookContext): Promise<void> {
  if (!isFeatureRequestIssue(options.payload.issue || {})) return;

  const issueNumber = String(options.payload.issue?.number || "");
  const comments = await issueComments(options, issueNumber);
  if (hasConversionMarker(options.payload.issue || {}, comments)) return;

  try {
    await addIssueLabel(options, issueNumber, gitVibeLabels.needsDiscussion.name);
    const discussion = await createRepositoryDiscussion({
      body: buildDiscussionBody({
        issue: options.payload.issue || {},
        owner: options.owner,
        repo: options.repo,
      }),
      categoryName: options.config.discussionCategory,
      client: options.client,
      repository: `${options.owner}/${options.repo}`,
      title: buildDiscussionTitle(options.payload.issue || {}),
      token: options.token,
    });
    await createIssueComment(options, issueNumber, convertedIssueComment(discussion));
    await closeIssue(options, issueNumber);
  } catch (error) {
    options.log(`feature issue conversion failed for #${issueNumber}: ${summarizeError(error)}`);
    if (!hasDiscussionSetupMarker(comments)) {
      await createIssueComment(options, issueNumber, discussionSetupErrorComment(error));
    }
  }
}

async function handleIssueComment(options: WebhookContext): Promise<void> {
  const parsed = parseCommand(options.payload.comment?.body?.trim() || "");
  if (!parsed) return;
  await requireTrustedActor(options);

  const issueNumber = String(options.payload.issue?.number || "");
  if (parsed.command === "address-feedback" && options.payload.issue?.pull_request) {
    await acknowledgeCommand(options);
    const workflow = "address-feedback.yml";
    const dispatch = await dispatchWorkflow(
      options,
      workflow,
      commandInputs(options, { "pr-number": issueNumber }, "pull-request-comment"),
    );
    await postQueuedWorkflowComment(options, {
      artifact: "pull-request",
      number: issueNumber,
      reason: commandReason(parsed.raw),
      workflow,
      workflowRunUrl: dispatch.html_url,
    });
    return;
  }

  const workflow = commandWorkflow(parsed.command);
  if (workflow && !options.payload.issue?.pull_request) {
    await acknowledgeCommand(options);
    const dispatch = await dispatchWorkflow(
      options,
      workflow,
      commandInputs(options, { "issue-number": issueNumber }, "issue-comment"),
    );
    await postQueuedWorkflowComment(options, {
      artifact: "issue",
      number: issueNumber,
      reason: commandReason(parsed.raw),
      workflow,
      workflowRunUrl: dispatch.html_url,
    });
    return;
  }

  options.log(`recognized command but no dispatch rule matched: ${parsed.raw}`);
}

async function handleDiscussionComment(options: WebhookContext): Promise<void> {
  const parsed = parseCommand(options.payload.comment?.body?.trim() || "");
  if (!parsed) return;
  await requireTrustedActor(options);

  if (parsed.command === "summarize") {
    const workflow = "summarize.yml";
    await acknowledgeCommand(options);
    const dispatch = await dispatchWorkflow(options, workflow, {
      "discussion-number": String(options.payload.discussion?.number || ""),
      "source-comment": sourceCommentInput(options, "discussion-comment"),
    });
    await postQueuedWorkflowComment(options, {
      artifact: "discussion",
      number: String(options.payload.discussion?.number || ""),
      reason: commandReason(parsed.raw),
      workflow,
      workflowRunUrl: dispatch.html_url,
    });
    return;
  }

  options.log(`recognized command but no dispatch rule matched: ${parsed.raw}`);
}

async function handleIssueLabeled(options: WebhookContext): Promise<void> {
  const label = options.payload.label?.name || "";
  if (!isProtectedGitVibeLabel(label)) return;

  const issueNumber = String(options.payload.issue?.number || "");

  if (!(await isTrustedActor(options))) {
    await removeIssueLabel({
      client: options.client,
      issueNumber,
      label,
      owner: options.owner,
      repo: options.repo,
      token: options.token,
    });
    await createIssueComment(options, issueNumber, protectedLabelRejectionBody(options, label));
    return;
  }

  if (label === gitVibeLabels.approved.name) {
    const dispatch = await dispatchWorkflow(options, "develop.yml", {
      "issue-number": issueNumber,
    });
    await postQueuedWorkflowComment(options, {
      artifact: "issue",
      number: issueNumber,
      reason: labelReason(label),
      workflow: "develop.yml",
      workflowRunUrl: dispatch.html_url,
    });
    return;
  }

  if (label === gitVibeLabels.validate.name) {
    const dispatch = await dispatchWorkflow(options, "validate.yml", {
      "issue-number": issueNumber,
    });
    await removeIssueLabel({
      client: options.client,
      issueNumber,
      label,
      owner: options.owner,
      repo: options.repo,
      token: options.token,
    });
    await postQueuedWorkflowComment(options, {
      artifact: "issue",
      number: issueNumber,
      reason: labelReason(label),
      workflow: "validate.yml",
      workflowRunUrl: dispatch.html_url,
    });
    return;
  }

  if (label === gitVibeInternalLabels.reviewFix.name) {
    await handleReviewFixLabel(options, issueNumber);
    return;
  }

  if (isInternalGitVibeLabel(label)) {
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
}

async function handleDiscussionLabeled(options: WebhookContext): Promise<void> {
  const label = options.payload.label?.name || "";
  if (!isProtectedGitVibeLabel(label)) return;

  const discussionNumber = String(options.payload.discussion?.number || "");

  if (!(await isTrustedActor(options))) {
    await removeDiscussionLabelFromPayload(options, label);
    await createDiscussionComment(options, protectedLabelRejectionBody(options, label));
    return;
  }

  if (label === gitVibeLabels.validate.name) {
    const dispatch = await dispatchWorkflow(options, "validate.yml", {
      "discussion-number": discussionNumber,
    });
    await removeDiscussionLabelFromPayload(options, label);
    await postQueuedWorkflowComment(options, {
      artifact: "discussion",
      number: discussionNumber,
      reason: labelReason(label),
      workflow: "validate.yml",
      workflowRunUrl: dispatch.html_url,
    });
    return;
  }

  if (label === gitVibeLabels.approved.name) {
    const dispatch = await dispatchWorkflow(options, "materialize.yml", {
      "discussion-number": discussionNumber,
    });
    await postQueuedWorkflowComment(options, {
      artifact: "discussion",
      number: discussionNumber,
      reason: labelReason(label),
      workflow: "materialize.yml",
      workflowRunUrl: dispatch.html_url,
    });
    return;
  }

  if (isInternalGitVibeLabel(label)) {
    await removeDiscussionLabelFromPayload(options, label);
    await createDiscussionComment(options, internalLabelRejectionBody(label));
  }
}

async function handlePullRequestReviewSubmitted(options: WebhookContext): Promise<void> {
  const state = String(options.payload.review?.state || "").toLowerCase();
  const prNumber = String(options.payload.pull_request?.number || "");
  if (state !== "changes_requested") {
    options.log(`ignored pull_request_review.${state || "unknown"} for PR #${prNumber}`);
    return;
  }
  if (!(await isTrustedActor(options))) {
    options.log(
      `ignored changes_requested review from untrusted actor @${options.payload.sender?.login || "<missing>"} on PR #${prNumber}`,
    );
    return;
  }

  const dispatch = await dispatchWorkflow(options, "address-feedback.yml", {
    "pr-number": prNumber,
    "source-comment": sourceReviewInput(options),
  });
  await postQueuedWorkflowComment(options, {
    artifact: "pull-request",
    number: prNumber,
    reason: "trusted changes-requested review",
    workflow: "address-feedback.yml",
    workflowRunUrl: dispatch.html_url,
  });
}

async function handleReviewFixLabel(options: WebhookContext, issueNumber: string): Promise<void> {
  const trace = reviewFixTraceFromBody(options.payload.issue?.body || "");
  if (!trace) {
    await removeIssueLabel({
      client: options.client,
      issueNumber,
      label: gitVibeInternalLabels.reviewFix.name,
      owner: options.owner,
      repo: options.repo,
      token: options.token,
    });
    await createIssueComment(
      options,
      issueNumber,
      internalLabelRejectionBody(gitVibeInternalLabels.reviewFix.name),
    );
    return;
  }

  options.log(`accepted managed internal review-fix label on issue #${issueNumber}`);
}

async function requireTrustedActor(options: WebhookContext): Promise<void> {
  if (!(await isTrustedActor(options))) {
    throw Object.assign(
      new Error(
        `actor ${options.payload.sender?.login || "<missing>"} does not have permission to run GitVibe commands`,
      ),
      { statusCode: 403 },
    );
  }
}

async function isTrustedActor(options: WebhookContext): Promise<boolean> {
  const actor = options.payload.sender?.login;
  if (!actor) return false;

  let permission: { permission?: string; role_name?: string };
  try {
    permission = await options.client.request<{ permission?: string; role_name?: string }>({
      method: "GET",
      path: `/repos/${options.owner}/${options.repo}/collaborators/${actor}/permission`,
      token: options.token,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) return false;
    throw error;
  }

  return (
    trustedPermissions.has(permission.permission || "") ||
    trustedPermissions.has(permission.role_name || "")
  );
}

async function dispatchWorkflow(
  options: WebhookContext,
  workflow: string,
  inputs: Record<string, string>,
): Promise<WorkflowDispatchResult> {
  const body = {
    inputs,
    ref: options.config.dispatchRef,
    return_run_details: true,
  };
  try {
    return await options.client.request<WorkflowDispatchResult>({
      apiVersion: "2026-03-10",
      body,
      method: "POST",
      path: `/repos/${options.owner}/${options.repo}/actions/workflows/${workflow}/dispatches`,
      token: options.token,
    });
  } catch (error) {
    if (!isDispatchRunDetailsCompatibilityError(error)) throw error;
    options.log(
      `workflow dispatch run details unavailable for ${workflow}: ${summarizeError(error)}`,
    );
  }

  await options.client.request({
    body: {
      inputs,
      ref: options.config.dispatchRef,
    },
    method: "POST",
    path: `/repos/${options.owner}/${options.repo}/actions/workflows/${workflow}/dispatches`,
    token: options.token,
  });
  return {};
}

function commandInputs(
  options: WebhookContext,
  inputs: Record<string, string>,
  kind: SourceCommentKind,
): Record<string, string> {
  return {
    ...inputs,
    "source-comment": sourceCommentInput(options, kind),
  };
}

function sourceCommentInput(options: WebhookContext, kind: SourceCommentKind): string {
  return encodeSourceComment(sourceCommentFromPayload(options.payload.comment, kind));
}

function sourceReviewInput(options: WebhookContext): string {
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

async function createQueuedWorkflowComment(
  options: WebhookContext,
  comment: {
    artifact: "issue" | "pull-request" | "discussion";
    number: string;
    reason: string;
    workflow: string;
    workflowRunUrl?: string;
  },
): Promise<void> {
  const body = queuedWorkflowComment({
    artifact: comment.artifact,
    number: comment.number,
    reason: comment.reason,
    ref: options.config.dispatchRef,
    workflow: comment.workflow,
    workflowRunUrl: comment.workflowRunUrl,
  });
  if (comment.artifact === "discussion") {
    await createDiscussionComment(options, body);
    return;
  }
  await createIssueComment(options, comment.number, body);
}

async function postQueuedWorkflowComment(
  options: WebhookContext,
  comment: Parameters<typeof createQueuedWorkflowComment>[1],
): Promise<void> {
  try {
    await createQueuedWorkflowComment(options, comment);
  } catch (error) {
    options.log(`workflow queued comment failed: ${summarizeError(error)}`);
  }
}

async function createDiscussionComment(options: WebhookContext, body: string): Promise<void> {
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

function discussionNodeId(discussion: WebhookPayload["discussion"]): string {
  const subjectId = discussion?.node_id || discussion?.nodeId || discussion?.id;
  return typeof subjectId === "string" ? subjectId : "";
}

async function removeDiscussionLabelFromPayload(
  options: WebhookContext,
  label: string,
): Promise<void> {
  const discussionId = discussionNodeId(options.payload.discussion);
  if (!discussionId) throw new Error("missing discussion node_id for label removal");

  await removeDiscussionLabel({
    client: options.client,
    discussionId,
    label,
    labelId: labelNodeId(options.payload.label),
    repository: `${options.owner}/${options.repo}`,
    token: options.token,
  });
}

function labelNodeId(label: WebhookPayload["label"]): string | undefined {
  const labelId = label?.node_id || label?.nodeId || label?.id;
  return typeof labelId === "string" ? labelId : undefined;
}

function queuedWorkflowComment(options: {
  artifact: "issue" | "pull-request" | "discussion";
  number: string;
  reason: string;
  ref: string;
  workflow: string;
  workflowRunUrl?: string;
}): string {
  const lines = [
    `<!-- git-vibe:workflow-queued workflow=${options.workflow} artifact=${options.artifact} number=${options.number} -->`,
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

function commandReason(raw: string): string {
  return `command ${inlineCode(raw)}`;
}

function labelReason(label: string): string {
  return `${inlineCode(label)} label`;
}

async function acknowledgeCommand(options: WebhookContext): Promise<void> {
  const subjectId = commandCommentNodeId(options.payload.comment);
  if (!subjectId) {
    options.log("command acknowledgement skipped: missing comment node_id");
    return;
  }

  try {
    await options.client.graphql(
      addReactionMutation,
      { content: "ROCKET", subjectId },
      options.token,
    );
  } catch (error) {
    options.log(`command acknowledgement failed: ${summarizeError(error)}`);
  }
}

function commandCommentNodeId(comment: WebhookPayload["comment"]): string {
  const subjectId = comment?.node_id || comment?.nodeId;
  return typeof subjectId === "string" ? subjectId : "";
}

async function createIssueComment(
  options: WebhookContext,
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

async function issueComments(
  options: WebhookContext,
  issueNumber: string,
): Promise<IntakeComment[]> {
  return options.client.request<IntakeComment[]>({
    method: "GET",
    path: `/repos/${options.owner}/${options.repo}/issues/${issueNumber}/comments?per_page=100`,
    token: options.token,
  });
}

async function closeIssue(options: WebhookContext, issueNumber: string): Promise<void> {
  await options.client.request({
    body: { state: "closed", state_reason: "completed" },
    method: "PATCH",
    path: `/repos/${options.owner}/${options.repo}/issues/${issueNumber}`,
    token: options.token,
  });
}

async function addIssueLabel(
  options: WebhookContext,
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

const trustedPermissions = new Set(["admin", "maintain", "write"]);

const addReactionMutation = /* GraphQL */ `
  mutation GitVibeAddReaction($content: ReactionContent!, $subjectId: ID!) {
    addReaction(input: { content: $content, subjectId: $subjectId }) {
      reaction {
        content
      }
    }
  }
`;

function commandWorkflow(command: string): string | null {
  if (command === "investigate") return "investigate.yml";
  return null;
}

interface WorkflowDispatchResult extends Record<string, unknown> {
  html_url?: string;
  run_url?: string;
  workflow_run_id?: number | string;
}

function isDispatchRunDetailsCompatibilityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("return_run_details") || message.includes("not a permitted key");
}

function verifyGitHubSignature(
  body: string,
  signatureHeader: string | undefined,
  secret: string,
): void {
  if (!signatureHeader?.startsWith("sha256=")) {
    throw Object.assign(new Error("missing GitHub signature"), { statusCode: 401 });
  }

  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const actual = signatureHeader.slice("sha256=".length);
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  if (
    expectedBuffer.length !== actualBuffer.length ||
    !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    throw Object.assign(new Error("invalid GitHub signature"), { statusCode: 401 });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function protectedLabelRejectionBody(options: WebhookContext, label: string): string {
  return `GitVibe removed \`${label}\` because @${options.payload.sender?.login || "<missing>"} is not allowed to control GitVibe automation labels for this repository.`;
}

function internalLabelRejectionBody(label: string): string {
  return `GitVibe removed \`${label}\` because \`gvi:\` labels are internal runtime labels and must only be applied by GitVibe with a valid hidden marker.`;
}

function sendJson(res: ServerResponse, statusCode: number, value: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name] || "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function toHttpError(error: unknown): Error & { statusCode?: number } {
  return error instanceof Error
    ? (error as Error & { statusCode?: number })
    : new Error(String(error));
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (isDirectRun(import.meta.url)) {
  startServerFromEnv();
}
