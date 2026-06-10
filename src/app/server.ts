#!/usr/bin/env node

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRepositoryDiscussion } from "../shared/discussions.js";
import { GitHubClient } from "../shared/github.js";
import {
  defaultTrustedWorkflowRefPattern,
  exchangeActionsToken,
  RemoteGitHubActionsOidcVerifier,
  type GitHubActionsOidcVerifier,
} from "./actions-token.js";
import { writeBackActionsCodexAuth } from "./actions-codex-auth.js";
import {
  GitHubAppInstallationTokenProvider,
  type InstallationTokenProvider,
} from "./github-app-auth.js";
import {
  gitVibeInternalLabels,
  gitVibeLabels,
  isGitVibeRuntimeLabel,
  isInternalGitVibeLabel,
} from "../shared/labels.js";
import { defaultActionsOidcAudience } from "../shared/hosted-app.js";
import {
  buildDiscussionBody,
  buildDiscussionTitle,
  convertedIssueComment,
  discussionSetupErrorComment,
  hasConversionMarker,
  hasDiscussionSetupMarker,
  isFeatureRequestIssue,
} from "./intake.js";
import { bootstrapRepositoryLabels, isProtectedGitVibeLabel, removeIssueLabel } from "./labels.js";
import { parseCommand } from "./commands.js";
import {
  acknowledgeCommand,
  addDiscussionLabelFromPayload,
  addIssueLabel,
  closeIssue,
  commandInputs,
  commandReason,
  commandWorkflow,
  createDiscussionComment,
  createIssueComment,
  dispatchWorkflow,
  discussionHasLabel,
  handleManagedReviewFixLabel,
  internalLabelRejectionBody,
  issueComments,
  labelReason,
  markPullRequestApproved,
  markPullRequestMerged,
  materializeRequiresValidationBody,
  postQueuedWorkflowComment,
  protectedLabelRejectionBody,
  removeDiscussionLabelBestEffort,
  removeDiscussionLabelFromPayload,
  removeIssueLabelIfPresent,
  repositoryWorkflowBudgetInputs,
  sourceReviewInput,
} from "./server-actions.js";
import { handleAcceptRiskLabel } from "./accept-risk-labels.js";
import { handleApprovedIssueLabel } from "./approval-labels.js";
import { handleReviewPullRequestLabel } from "./review-labels.js";
import { createDeliveryDeduplicator, type DeliveryDeduplicator } from "./delivery-dedup.js";
import { handleRequest as handleHttpRequest } from "./request-handler.js";
import { requiredEnv } from "./server-http.js";
import { runStartupPreflight } from "./startup-preflight.js";
import type { WebhookPayload } from "./types.js";

export interface GitVibeApp {
  handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
  handleWebhook(event: string, payload: WebhookPayload): Promise<void>;
  runStartupPreflight(): Promise<void>;
}

export interface GitVibeAppOptions {
  actionsOidcAudience?: string;
  actionsOidcVerifier?: GitHubActionsOidcVerifier;
  appAuth: InstallationTokenProvider;
  client?: GitHubClient;
  configuredRepository?: string;
  discussionCategory?: string;
  errorLog?: (message: string) => void;
  log?: (message: string) => void;
  trustedWorkflowRefPattern?: RegExp;
  webhookSecret: string;
}

interface AppState {
  actionsOidcVerifier: GitHubActionsOidcVerifier;
  appAuth: InstallationTokenProvider;
  bootstrappedRepositories: Set<string>;
  client: GitHubClient;
  config: {
    actionsOidcAudience: string;
    configuredRepository: string;
    discussionCategory: string;
    webhookSecret: string;
  };
  deliveries: DeliveryDeduplicator;
  errorLog: (message: string) => void;
  log: (message: string) => void;
  trustedWorkflowRefPattern: RegExp;
}

interface WebhookContext extends AppState {
  owner: string;
  payload: WebhookPayload;
  repo: string;
  token: string;
}

export function createGitVibeApp(options: GitVibeAppOptions): GitVibeApp {
  const state: AppState = {
    actionsOidcVerifier: options.actionsOidcVerifier || new RemoteGitHubActionsOidcVerifier(),
    appAuth: options.appAuth,
    bootstrappedRepositories: new Set<string>(),
    client: options.client || new GitHubClient(),
    config: {
      actionsOidcAudience: options.actionsOidcAudience || defaultActionsOidcAudience,
      configuredRepository: options.configuredRepository || "",
      discussionCategory: options.discussionCategory || "Ideas",
      webhookSecret: options.webhookSecret,
    },
    deliveries: createDeliveryDeduplicator(),
    errorLog: options.errorLog || ((message) => console.error(`[git-vibe] ${message}`)),
    log: options.log || ((message) => console.log(`[git-vibe] ${message}`)),
    trustedWorkflowRefPattern:
      options.trustedWorkflowRefPattern || defaultTrustedWorkflowRefPattern,
  };

  return {
    handleRequest: (req, res) =>
      handleHttpRequest(
        state,
        req,
        res,
        (event, payload) => handleWebhook(state, event, payload),
        (body) => handleActionsToken(state, body),
        (body) => handleActionsCodexAuthWriteback(state, body),
      ),
    handleWebhook: (event, payload) => handleWebhook(state, event, payload),
    runStartupPreflight: () =>
      runStartupPreflight({
        appAuth: state.appAuth,
        bootstrappedRepositories: state.bootstrappedRepositories,
        client: state.client,
        configuredRepository: state.config.configuredRepository,
        discussionCategory: state.config.discussionCategory,
        errorLog: state.errorLog,
        log: state.log,
      }),
  };
}

export function startServerFromEnv(env: NodeJS.ProcessEnv = process.env): Server {
  const port = Number(env.PORT || 3000);
  const client = new GitHubClient();
  const app = createGitVibeApp({
    actionsOidcAudience: env.GITVIBE_ACTIONS_OIDC_AUDIENCE || defaultActionsOidcAudience,
    appAuth: new GitHubAppInstallationTokenProvider({
      appId: requiredEnv(env, "GITHUB_APP_ID"),
      client,
      privateKey: requiredEnv(env, "GITVIBE_APP_PRIVATE_KEY"),
    }),
    client,
    configuredRepository: env.GITHUB_REPOSITORY || "",
    discussionCategory: env.GITVIBE_DISCUSSION_CATEGORY || "Ideas",
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
  const installationId = payload.installation?.id;
  if (!installationId) {
    state.log(`ignored ${event}: missing GitHub App installation id`);
    return;
  }

  const token = await state.appAuth.tokenForRepository({
    installationId,
    owner,
    profile: "server",
    repo,
  });
  await bootstrapRepositoryLabels({
    bootstrappedRepositories: state.bootstrappedRepositories,
    client: state.client,
    log: state.log,
    owner,
    repo,
    token,
  });

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

  if (event === "pull_request" && payload.action === "closed" && payload.pull_request) {
    await handlePullRequestClosed({ ...state, owner, payload, repo, token });
    return;
  }

  if (
    event === "pull_request" &&
    payload.action === "labeled" &&
    payload.pull_request &&
    (payload.label?.name === gitVibeLabels.review.name ||
      payload.label?.name === gitVibeLabels.acceptRisk.name)
  ) {
    await handleIssueLabeled({
      ...state,
      owner,
      payload: pullRequestLabelPayload(payload),
      repo,
      token,
    });
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

function handleActionsToken(state: AppState, body: string) {
  return exchangeActionsToken({
    audience: state.config.actionsOidcAudience,
    body,
    client: state.client,
    tokenProvider: state.appAuth,
    trustedWorkflowRefPattern: state.trustedWorkflowRefPattern,
    verifier: state.actionsOidcVerifier,
  });
}

function handleActionsCodexAuthWriteback(state: AppState, body: string) {
  return writeBackActionsCodexAuth({
    audience: state.config.actionsOidcAudience,
    body,
    client: state.client,
    tokenProvider: state.appAuth,
    trustedWorkflowRefPattern: state.trustedWorkflowRefPattern,
    verifier: state.actionsOidcVerifier,
  });
}

function pullRequestLabelPayload(payload: WebhookPayload): WebhookPayload {
  return {
    ...payload,
    issue: {
      body: payload.pull_request?.body,
      number: payload.pull_request?.number,
      pull_request: {},
      title: payload.pull_request?.title,
    },
  };
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
    const acknowledged = await acknowledgeCommand(options);
    const workflow = "address-feedback.yml";
    const dispatch = await dispatchWorkflow(options, workflow, {
      ...(await repositoryWorkflowBudgetInputs(options, workflow)),
      ...commandInputs(options, { "pr-number": issueNumber }, "pull-request-comment"),
    });
    if (!acknowledged)
      await postQueuedWorkflowComment(options, {
        artifact: "pull-request",
        number: issueNumber,
        reason: commandReason(parsed.raw),
        workflow,
        ref: dispatch.ref,
        workflowRunUrl: dispatch.html_url,
      });
    return;
  }

  const workflow = commandWorkflow(parsed.command);
  if (workflow && !options.payload.issue?.pull_request) {
    const acknowledged = await acknowledgeCommand(options);
    const dispatch = await dispatchWorkflow(options, workflow, {
      ...(await repositoryWorkflowBudgetInputs(options, workflow)),
      ...commandInputs(options, { "issue-number": issueNumber }, "issue-comment"),
    });
    if (!acknowledged)
      await postQueuedWorkflowComment(options, {
        artifact: "issue",
        number: issueNumber,
        reason: commandReason(parsed.raw),
        workflow,
        ref: dispatch.ref,
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

  if (parsed.command === "materialize") {
    const discussionNumber = String(options.payload.discussion?.number || "");
    if (!(await discussionHasLabel(options, gitVibeLabels.validated.name))) {
      await createDiscussionComment(
        options,
        materializeRequiresValidationBody(commandReason(parsed.raw)),
      );
      return;
    }

    const acknowledged = await acknowledgeCommand(options);
    const workflow = "materialize.yml";
    const dispatch = await dispatchWorkflow(
      options,
      workflow,
      commandInputs(options, { "discussion-number": discussionNumber }, "discussion-comment"),
    );
    if (!acknowledged)
      await postQueuedWorkflowComment(options, {
        artifact: "discussion",
        number: discussionNumber,
        reason: commandReason(parsed.raw),
        workflow,
        ref: dispatch.ref,
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
  const runtimeLabel = isGitVibeRuntimeLabel(label);
  const githubActionsActor = options.payload.sender?.login === "github-actions[bot]";

  if (!(runtimeLabel && githubActionsActor) && !(await isTrustedActor(options))) {
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

  if (runtimeLabel) {
    options.log(`accepted managed runtime label ${label} on issue #${issueNumber}`);
    return;
  }

  if (label === gitVibeLabels.investigate.name) {
    await handleInvestigateIssueLabel(options, issueNumber, label);
    return;
  }

  if (label === gitVibeLabels.acceptRisk.name) {
    await handleAcceptRiskLabel(options, label);
    return;
  }

  if (label === gitVibeLabels.review.name) {
    await handleReviewPullRequestLabel(options, issueNumber, label);
    return;
  }

  if (label === gitVibeLabels.approved.name) {
    await handleApprovedIssueLabel(options, issueNumber, label);
    return;
  }

  if (label === gitVibeLabels.validate.name) {
    const workflow = "validate.yml";
    const dispatch = await dispatchWorkflow(options, workflow, {
      ...(await repositoryWorkflowBudgetInputs(options, workflow)),
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
      workflow,
      ref: dispatch.ref,
      workflowRunUrl: dispatch.html_url,
    });
    return;
  }

  if (label === gitVibeInternalLabels.reviewFix.name) {
    await handleManagedReviewFixLabel(options, issueNumber);
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

async function handleInvestigateIssueLabel(
  options: WebhookContext,
  issueNumber: string,
  label: string,
): Promise<void> {
  const workflow = "investigate.yml";
  await dispatchWorkflow(options, workflow, {
    ...(await repositoryWorkflowBudgetInputs(options, workflow)),
    "issue-number": issueNumber,
  });
  await removeIssueLabelIfPresent(options, issueNumber, gitVibeLabels.blocked.name);
  await addIssueLabel(options, issueNumber, gitVibeLabels.investigating.name);
  await removeIssueLabel({
    client: options.client,
    issueNumber,
    label,
    owner: options.owner,
    repo: options.repo,
    token: options.token,
  });
}

async function handleDiscussionLabeled(options: WebhookContext): Promise<void> {
  const label = options.payload.label?.name || "";
  if (!isProtectedGitVibeLabel(label)) return;

  const discussionNumber = String(options.payload.discussion?.number || "");
  const runtimeLabel = isGitVibeRuntimeLabel(label);
  const githubActionsActor = options.payload.sender?.login === "github-actions[bot]";

  if (!(runtimeLabel && githubActionsActor) && !(await isTrustedActor(options))) {
    await removeDiscussionLabelFromPayload(options, label);
    await createDiscussionComment(options, protectedLabelRejectionBody(options, label));
    return;
  }

  if (runtimeLabel) {
    options.log(`accepted managed runtime label ${label} on discussion #${discussionNumber}`);
    return;
  }

  if (label === gitVibeLabels.validate.name) {
    const workflow = "validate.yml";
    const dispatch = await dispatchWorkflow(options, workflow, {
      ...(await repositoryWorkflowBudgetInputs(options, workflow)),
      "discussion-number": discussionNumber,
    });
    await addDiscussionLabelFromPayload(options, gitVibeLabels.validating.name);
    await postQueuedWorkflowComment(options, {
      artifact: "discussion",
      number: discussionNumber,
      reason: labelReason(label),
      workflow,
      ref: dispatch.ref,
      workflowRunUrl: dispatch.html_url,
    });
    await removeDiscussionLabelBestEffort(options, label);
    return;
  }

  if (label === gitVibeLabels.acceptRisk.name) {
    await handleAcceptRiskLabel(options, label);
    return;
  }

  if (label === gitVibeLabels.approved.name) {
    if (!(await discussionHasLabel(options, gitVibeLabels.validated.name))) {
      await removeDiscussionLabelFromPayload(options, label);
      await createDiscussionComment(options, materializeRequiresValidationBody(labelReason(label)));
      return;
    }

    const workflow = "materialize.yml";
    const dispatch = await dispatchWorkflow(options, workflow, {
      ...(await repositoryWorkflowBudgetInputs(options, workflow)),
      "discussion-number": discussionNumber,
    });
    await postQueuedWorkflowComment(options, {
      artifact: "discussion",
      number: discussionNumber,
      reason: labelReason(label),
      workflow,
      ref: dispatch.ref,
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
  if (state === "approved") {
    if (!(await isTrustedActor(options))) {
      options.log(
        `ignored approved review from untrusted actor @${options.payload.sender?.login || "<missing>"} on PR #${prNumber}`,
      );
      return;
    }
    await markPullRequestApproved(options, prNumber);
    return;
  }

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

  const workflow = "address-feedback.yml";
  const dispatch = await dispatchWorkflow(options, workflow, {
    ...(await repositoryWorkflowBudgetInputs(options, workflow)),
    "pr-number": prNumber,
    "source-comment": sourceReviewInput(options),
  });
  await postQueuedWorkflowComment(options, {
    artifact: "pull-request",
    number: prNumber,
    reason: "trusted changes-requested review",
    workflow,
    ref: dispatch.ref,
    workflowRunUrl: dispatch.html_url,
  });
}

async function handlePullRequestClosed(options: WebhookContext): Promise<void> {
  const prNumber = String(options.payload.pull_request?.number || "");
  if (!options.payload.pull_request?.merged) {
    options.log(`ignored pull_request.closed unmerged PR #${prNumber}`);
    return;
  }

  await markPullRequestMerged(options, prNumber);
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

const trustedPermissions = new Set(["admin", "maintain", "write"]);

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (isDirectRun(import.meta.url)) {
  startServerFromEnv();
}
