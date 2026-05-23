import { reviewWorkflowBudgetInputs } from "../shared/budgets.js";
import { baseBranchFromEnv } from "../shared/config.js";
import { GitHubClient, repositoryDefaultBranch, splitRepository } from "../shared/github.js";
import { workflowQueuedMarker, workflowRunIdFromUrl } from "../shared/status-comments.js";
import type { ContextPacket, GitVibeConfig, RunnerOptions } from "../shared/types.js";
import type { StageLogger } from "./logging.js";

export async function dispatchPullRequestReviewWorkflow(options: {
  client: GitHubClient;
  config: GitVibeConfig;
  context: ContextPacket;
  logger: StageLogger;
  runner: RunnerOptions;
}): Promise<void> {
  if (options.context.artifact.type !== "pull-request") {
    throw new Error("Cannot dispatch PR review workflow without a pull request context.");
  }

  const { owner, repo } = splitRepository(options.runner.repository);
  const ref = await workflowBaseRef({ ...options, owner, repo });
  options.logger.event("github.workflow.dispatch.start", {
    pull_request: options.context.artifact.number,
    workflow: "review.yml",
  });
  const dispatch = await dispatchWorkflowWithRunDetails({
    client: options.client,
    inputs: {
      ...reviewWorkflowBudgetInputs(options.config),
      "pr-number": options.context.artifact.number,
    },
    logger: options.logger,
    owner,
    ref,
    repo,
    token: options.runner.token,
    workflow: "review.yml",
  });
  await createQueuedReviewComment({ ...options, workflowRunUrl: dispatch.html_url });
  options.logger.event("github.workflow.dispatch.done", {
    pull_request: options.context.artifact.number,
    workflow: "review.yml",
  });
}

async function createQueuedReviewComment(options: {
  client: GitHubClient;
  context: ContextPacket;
  runner: RunnerOptions;
  workflowRunUrl?: string;
}): Promise<void> {
  const { owner, repo } = splitRepository(options.runner.repository);
  await options.client.request({
    body: {
      body: queuedReviewComment({
        pullRequest: options.context.artifact.number,
        workflowRunUrl: options.workflowRunUrl,
      }),
    },
    method: "POST",
    path: `/repos/${owner}/${repo}/issues/${options.context.artifact.number}/comments`,
    token: options.runner.token,
  });
}

function queuedReviewComment(options: { pullRequest: string; workflowRunUrl?: string }): string {
  const run = workflowRunIdFromUrl(options.workflowRunUrl);
  const lines = [
    workflowQueuedMarker({
      artifact: "pull-request",
      number: options.pullRequest,
      run,
      workflow: "review.yml",
    }),
    "## GitVibe Workflow Queued",
    "",
    `GitVibe queued \`review.yml\` for pull request #${options.pullRequest} after addressing feedback.`,
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

interface WorkflowDispatchResult extends Record<string, unknown> {
  html_url?: string;
}
