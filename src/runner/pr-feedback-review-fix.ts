import { baseBranchFromEnv } from "../shared/config.js";
import { GitHubClient, repositoryDefaultBranch, splitRepository } from "../shared/github.js";
import { gitVibeInternalLabels } from "../shared/labels.js";
import {
  pullRequestReviewFixFromBody,
  pullRequestReviewFixMarker,
} from "../shared/traceability.js";
import { workflowQueuedMarker, workflowRunIdFromUrl } from "../shared/status-comments.js";
import type { StageLogger } from "./logging.js";
import {
  applyStageLabelTransition,
  type PublishedArtifactComment,
  publishStageResultComment,
} from "./stage-publishing.js";
import type {
  ContextPacket,
  GitVibeConfig,
  JsonObject,
  RunnerOptions,
  StageRunResult,
} from "../shared/types.js";

const maxPullRequestReviewFixIterations = 3;

export async function maybeHandlePullRequestReviewFixRequired(options: {
  client: GitHubClient;
  config: GitVibeConfig;
  context: ContextPacket;
  logger: StageLogger;
  result: StageRunResult;
  runner: RunnerOptions;
  transientComments: PublishedArtifactComment[];
}): Promise<StageRunResult | undefined> {
  if (
    options.runner.stage !== "review-matrix" ||
    options.context.artifact.type !== "pull-request" ||
    !isReviewChangesRequired(options.result.parsedOutput)
  ) {
    return undefined;
  }

  return handlePullRequestReviewFixRequired(options);
}

async function handlePullRequestReviewFixRequired(options: {
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  result: StageRunResult;
  runner: RunnerOptions;
  transientComments: PublishedArtifactComment[];
}): Promise<StageRunResult> {
  await publishStageResultComment({
    ...options,
    parsedOutput: options.result.parsedOutput,
    runner: options.runner,
    transientComments: options.transientComments,
  });
  await applyStageLabelTransition({
    ...options,
    parsedOutput: options.result.parsedOutput,
    runner: options.runner,
  });

  const depth = nextPullRequestReviewFixDepth(options.context);
  if (depth > maxPullRequestReviewFixIterations) {
    await addPullRequestReviewFixLabel(options);
    options.logger.event("github.workflow.dispatch.skip", {
      depth,
      max_depth: maxPullRequestReviewFixIterations,
      reason: "pr-review-fix-depth",
    });
    return blockedPullRequestReviewFixResult({ ...options, depth });
  }

  const dispatch = await dispatchAddressFeedbackWorkflow({ ...options, depth });
  await createPullRequestReviewFixComment({
    ...options,
    depth,
    workflowRunUrl: dispatch.html_url,
  });
  await addPullRequestReviewFixLabel(options);
  return options.result;
}

function blockedPullRequestReviewFixResult(options: {
  depth: number;
  result: StageRunResult;
}): StageRunResult {
  const summary = `Review requested changes, but PR review-fix iteration ${options.depth} exceeds the configured limit of ${maxPullRequestReviewFixIterations}.`;
  const parsedOutput = {
    ...options.result.parsedOutput,
    next_state: "blocked",
    status: "blocked",
    summary,
  };
  return {
    ...options.result,
    parsedOutput,
    status: "blocked",
    summary,
  };
}

function nextPullRequestReviewFixDepth(context: ContextPacket): number {
  const depths = context.timeline
    .map((item) => pullRequestReviewFixFromBody(item.body))
    .filter((trace) => trace?.pullRequest === context.artifact.number)
    .map((trace) => trace?.depth || 0);
  return Math.max(0, ...depths) + 1;
}

async function dispatchAddressFeedbackWorkflow(options: {
  client: GitHubClient;
  context: ContextPacket;
  depth: number;
  logger: StageLogger;
  runner: RunnerOptions;
}): Promise<WorkflowDispatchResult> {
  const { owner, repo } = splitRepository(options.runner.repository);
  const ref = await workflowBaseRef({ ...options, owner, repo });
  options.logger.event("github.workflow.dispatch.start", {
    depth: options.depth,
    pull_request: options.context.artifact.number,
  });
  const dispatch = await dispatchWorkflowWithRunDetails({
    client: options.client,
    inputs: { "pr-number": options.context.artifact.number },
    logger: options.logger,
    owner,
    ref,
    repo,
    token: options.runner.token,
    workflow: "address-feedback.yml",
  });
  options.logger.event("github.workflow.dispatch.done", {
    depth: options.depth,
    pull_request: options.context.artifact.number,
  });
  return dispatch;
}

async function createPullRequestReviewFixComment(options: {
  client: GitHubClient;
  context: ContextPacket;
  depth: number;
  runner: RunnerOptions;
  workflowRunUrl?: string;
}): Promise<void> {
  const { owner, repo } = splitRepository(options.runner.repository);
  await options.client.request({
    body: {
      body: queuedPullRequestReviewFixComment({
        depth: options.depth,
        pullRequest: options.context.artifact.number,
        workflow: "address-feedback.yml",
        workflowRunUrl: options.workflowRunUrl,
      }),
    },
    method: "POST",
    path: `/repos/${owner}/${repo}/issues/${options.context.artifact.number}/comments`,
    token: options.runner.token,
  });
}

async function addPullRequestReviewFixLabel(options: {
  client: GitHubClient;
  context: ContextPacket;
  runner: RunnerOptions;
}): Promise<void> {
  const { owner, repo } = splitRepository(options.runner.repository);
  await options.client.request({
    body: { labels: [gitVibeInternalLabels.reviewFix.name] },
    method: "POST",
    path: `/repos/${owner}/${repo}/issues/${options.context.artifact.number}/labels`,
    token: options.runner.token,
  });
}

function queuedPullRequestReviewFixComment(options: {
  depth: number;
  pullRequest: string;
  workflow: string;
  workflowRunUrl?: string;
}): string {
  const run = workflowRunIdFromUrl(options.workflowRunUrl);
  const lines = [
    pullRequestReviewFixMarker({
      depth: options.depth,
      pullRequest: options.pullRequest,
    }),
    workflowQueuedMarker({
      artifact: "pull-request",
      number: options.pullRequest,
      run,
      workflow: options.workflow,
    }),
    "## GitVibe Workflow Queued",
    "",
    `GitVibe queued \`${options.workflow}\` for pull request #${options.pullRequest}.`,
  ];
  if (options.workflowRunUrl) lines.push("", `Workflow run: ${options.workflowRunUrl}`);
  lines.push("The runner will post again when the stage starts.");
  return lines.join("\n");
}

async function workflowBaseRef(options: {
  client: GitHubClient;
  logger: StageLogger;
  owner: string;
  repo: string;
  runner: RunnerOptions;
}): Promise<string> {
  const configured = baseBranchFromEnv();
  if (configured) return configured;
  options.logger.event("github.repository.lookup", { owner: options.owner, repo: options.repo });
  const defaultBranch = await repositoryDefaultBranch({
    client: options.client,
    owner: options.owner,
    repo: options.repo,
    token: options.runner.token,
  });
  options.logger.event("github.repository.lookup.done", { default_branch: defaultBranch });
  return defaultBranch;
}

async function dispatchWorkflowWithRunDetails(options: {
  client: GitHubClient;
  inputs: Record<string, string>;
  logger: StageLogger;
  owner: string;
  ref: string;
  repo: string;
  token: string;
  workflow: string;
}): Promise<WorkflowDispatchResult> {
  const path = `/repos/${options.owner}/${options.repo}/actions/workflows/${options.workflow}/dispatches`;
  try {
    return await options.client.request<WorkflowDispatchResult>({
      apiVersion: "2026-03-10",
      body: {
        inputs: options.inputs,
        ref: options.ref,
        return_run_details: true,
      },
      method: "POST",
      path,
      token: options.token,
    });
  } catch (error) {
    if (!isDispatchRunDetailsCompatibilityError(error)) throw error;
    options.logger.event("github.workflow.dispatch.run_details_unavailable", {
      error: error instanceof Error ? error.message : String(error),
      workflow: options.workflow,
    });
  }

  await options.client.request({
    body: {
      inputs: options.inputs,
      ref: options.ref,
    },
    method: "POST",
    path,
    token: options.token,
  });
  return {};
}

function isDispatchRunDetailsCompatibilityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("return_run_details") || message.includes("not a permitted key");
}

function isReviewChangesRequired(output: JsonObject): boolean {
  return (
    String(output.next_state || "")
      .trim()
      .toLowerCase()
      .replaceAll("_", "-") === "changes-required"
  );
}

interface WorkflowDispatchResult extends Record<string, unknown> {
  html_url?: string;
}
