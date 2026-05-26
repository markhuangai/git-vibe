import { execFileSync } from "node:child_process";
import { GitHubClient, repositoryDefaultBranch, splitRepository } from "../shared/github.js";
import { developWorkflowBudgetInputs } from "../shared/budgets.js";
import { baseBranchFromEnv } from "../shared/config.js";
import { gitVibeInternalLabels } from "../shared/labels.js";
import { workflowQueuedMarker, workflowRunIdFromUrl } from "../shared/status-comments.js";
import {
  gitVibeBranchName,
  reviewFixIssueBody,
  reviewFixLinkComment,
  reviewFixLinkFromBody,
  reviewFixTraceFromBody,
} from "../shared/traceability.js";
import type { StageLogger } from "./logging.js";
import { gitAuthEnv } from "./git-auth.js";
import { applyStageLabelTransition, publishStageResultComment } from "./stage-publishing.js";
import type {
  ContextPacket,
  GitVibeConfig,
  JsonObject,
  RunnerOptions,
  StageRunResult,
  TimelineItem,
} from "../shared/types.js";

interface IssueResponse extends JsonObject {
  body?: string;
  html_url?: string;
  id?: number;
  number?: number;
  title?: string;
}

export interface IssueBranchState {
  branch: string;
  remoteFound: boolean;
}

export async function prepareIssueBranch(options: {
  baseBranch?: string;
  branch: string;
  cwd: string;
  logger: StageLogger;
  token: string;
}): Promise<IssueBranchState> {
  const remoteRef = `refs/remotes/origin/${options.branch}`;
  options.logger.event("git.branch.prepare", { branch: options.branch });
  if (fetchRemoteBranch({ ...options, remoteRef })) {
    try {
      checkoutBranch(options.cwd, options.branch, remoteRef);
    } catch (error) {
      options.logger.event("git.branch.checkout.failed", {
        branch: options.branch,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    return { branch: options.branch, remoteFound: true };
  }

  options.logger.event("git.branch.fetch.missing", { branch: options.branch });
  if (options.baseBranch && hasOriginRemote(options.cwd)) {
    const baseRemoteRef = `refs/remotes/origin/${options.baseBranch}`;
    fetchBaseBranch({
      baseBranch: options.baseBranch,
      baseRemoteRef,
      cwd: options.cwd,
      token: options.token,
    });
    checkoutBranch(options.cwd, options.branch, baseRemoteRef);
    return { branch: options.branch, remoteFound: false };
  }

  checkoutBranch(options.cwd, options.branch);
  return { branch: options.branch, remoteFound: false };
}

export function issueBranch(context: ContextPacket): string {
  return (
    reviewFixTraceFromBody(context.artifact.body)?.branch ||
    gitVibeBranchName(context.artifact.number)
  );
}

function hasOriginRemote(cwd: string): boolean {
  try {
    execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function fetchRemoteBranch(options: {
  branch: string;
  cwd: string;
  remoteRef: string;
  token: string;
}): boolean {
  try {
    execFileSync("git", ["fetch", "origin", `+refs/heads/${options.branch}:${options.remoteRef}`], {
      cwd: options.cwd,
      env: gitAuthEnv(options.token),
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function fetchBaseBranch(options: {
  baseBranch: string;
  baseRemoteRef: string;
  cwd: string;
  token: string;
}): void {
  execFileSync(
    "git",
    ["fetch", "origin", `+refs/heads/${options.baseBranch}:${options.baseRemoteRef}`],
    { cwd: options.cwd, env: gitAuthEnv(options.token), stdio: "ignore" },
  );
}

function checkoutBranch(cwd: string, branch: string, startPoint?: string): void {
  const args = ["checkout", "-B", branch];
  if (startPoint) args.push(startPoint);
  execFileSync("git", args, {
    cwd,
    stdio: "inherit",
  });
}

export async function handleReviewFixRequired(options: {
  client: GitHubClient;
  config: GitVibeConfig;
  context: ContextPacket;
  logger: StageLogger;
  result: StageRunResult;
  runner: RunnerOptions;
}): Promise<StageRunResult> {
  const currentTrace = reviewFixTraceFromBody(options.context.artifact.body);
  const root = currentTrace?.root || options.context.artifact.number;
  const branch = currentTrace?.branch || gitVibeBranchName(root);
  const depth = (currentTrace?.depth || 0) + 1;
  const maxDepth = reviewFixMaxIterations();
  if (depth > maxDepth) return blockDepthExceeded({ ...options, depth, maxDepth });

  const existing = existingReviewFixLink(options.context.timeline, {
    depth,
    parent: options.context.artifact.number,
    root,
  });
  if (existing) {
    await dispatchDevelopWorkflow({
      ...options,
      issueNumber: existing.issue,
    });
    return options.result;
  }

  const issue = await createReviewFixIssue({ ...options, branch, depth, root });
  await createParentReviewFixComment({ ...options, depth, issue, root });
  await attachSubIssue({ ...options, issue });
  await dispatchDevelopWorkflow({ ...options, issueNumber: String(issue.number || "") });
  return options.result;
}

export async function issueChain(options: {
  client: GitHubClient;
  context: ContextPacket;
  runner: RunnerOptions;
}): Promise<string[]> {
  const { owner, repo } = splitRepository(options.runner.repository);
  const chain = [options.context.artifact.number];
  let body = options.context.artifact.body;

  for (;;) {
    const trace = reviewFixTraceFromBody(body);
    if (!trace || chain.includes(trace.parent)) break;
    chain.push(trace.parent);
    const parent = await options.client.request<IssueResponse>({
      method: "GET",
      path: `/repos/${owner}/${repo}/issues/${trace.parent}`,
      token: options.runner.token,
    });
    body = parent.body || "";
  }

  return chain.reverse();
}

export function appendIssueTraceability(
  body: string,
  issues: string[],
  options: { closingKeywords: boolean },
): string {
  const uniqueIssues = [...new Set(issues)];
  const verb = options.closingKeywords ? "Closes" : "Refs";
  const lines = uniqueIssues.map((issue) => `${verb} #${issue}`);
  const traceability = `## GitVibe Traceability\n\n${lines.join("\n")}`;
  const trimmedBody = body.trim();
  return trimmedBody ? `${trimmedBody}\n\n${traceability}` : traceability;
}

function reviewFixMaxIterations(): number {
  return 5;
}

async function blockDepthExceeded(options: {
  client: GitHubClient;
  context: ContextPacket;
  depth: number;
  logger: StageLogger;
  maxDepth: number;
  result: StageRunResult;
  runner: RunnerOptions;
}): Promise<StageRunResult> {
  const summary = `Review requested changes, but review-fix depth ${options.depth} exceeds the configured limit of ${options.maxDepth}.`;
  const parsedOutput = {
    ...options.result.parsedOutput,
    next_state: "blocked",
    status: "blocked",
    summary,
  };
  await publishStageResultComment({ ...options, parsedOutput });
  await applyStageLabelTransition({ ...options, parsedOutput });
  return {
    ...options.result,
    parsedOutput,
    status: "blocked",
    summary,
  };
}

async function createReviewFixIssue(options: {
  branch: string;
  client: GitHubClient;
  context: ContextPacket;
  depth: number;
  result: StageRunResult;
  root: string;
  runner: RunnerOptions;
}): Promise<IssueResponse> {
  const { owner, repo } = splitRepository(options.runner.repository);
  const parsed = options.result.parsedOutput;
  return options.client.request<IssueResponse>({
    body: {
      body: reviewFixIssueBody({
        branch: options.branch,
        commentBody: textField(parsed.comment_body),
        depth: options.depth,
        findings: arrayField(parsed.findings),
        parentIssue: options.context.artifact.number,
        parentUrl: options.context.artifact.url,
        references: arrayField(parsed.references),
        rootIssue: options.root,
        rootUrl: issueUrl(owner, repo, options.root),
        summary: options.result.summary,
      }),
      labels: [gitVibeInternalLabels.reviewFix.name],
      title: `Review fixes for #${options.root}: ${options.context.artifact.title || "GitVibe implementation"}`,
    },
    method: "POST",
    path: `/repos/${owner}/${repo}/issues`,
    token: options.runner.token,
  });
}

async function createParentReviewFixComment(options: {
  client: GitHubClient;
  context: ContextPacket;
  depth: number;
  issue: IssueResponse;
  root: string;
  runner: RunnerOptions;
}): Promise<void> {
  const { owner, repo } = splitRepository(options.runner.repository);
  await options.client.request({
    body: {
      body: reviewFixLinkComment({
        depth: options.depth,
        issueNumber: String(options.issue.number || ""),
        issueUrl: options.issue.html_url,
        parent: options.context.artifact.number,
        root: options.root,
        workflowRunUrl: options.runner.workflowRunUrl,
      }),
    },
    method: "POST",
    path: `/repos/${owner}/${repo}/issues/${options.context.artifact.number}/comments`,
    token: options.runner.token,
  });
}

async function attachSubIssue(options: {
  client: GitHubClient;
  context: ContextPacket;
  issue: IssueResponse;
  logger: StageLogger;
  runner: RunnerOptions;
}): Promise<void> {
  if (!options.issue.id) return;
  const { owner, repo } = splitRepository(options.runner.repository);
  try {
    await options.client.request({
      apiVersion: "2026-03-10",
      body: { sub_issue_id: options.issue.id },
      method: "POST",
      path: `/repos/${owner}/${repo}/issues/${options.context.artifact.number}/sub_issues`,
      token: options.runner.token,
    });
  } catch (error) {
    options.logger.event("github.sub_issue.create.failed", {
      error: error instanceof Error ? error.message : String(error),
      issue: options.issue.number || "",
      parent: options.context.artifact.number,
    });
  }
}

async function dispatchDevelopWorkflow(options: {
  client: GitHubClient;
  config: GitVibeConfig;
  issueNumber: string;
  logger: StageLogger;
  runner: RunnerOptions;
}): Promise<void> {
  if (!options.issueNumber)
    throw new Error("Cannot dispatch review-fix workflow without an issue number.");
  const { owner, repo } = splitRepository(options.runner.repository);
  options.logger.event("github.workflow.dispatch.start", { issue: options.issueNumber });
  const ref = await workflowBaseRef({ ...options, owner, repo });
  const dispatch = await dispatchWorkflowWithRunDetails({
    client: options.client,
    inputs: {
      ...developWorkflowBudgetInputs(options.config),
      "issue-number": options.issueNumber,
    },
    logger: options.logger,
    owner,
    ref,
    repo,
    token: options.runner.token,
    workflow: "develop.yml",
  });
  await options.client.request({
    body: {
      body: queuedReviewFixWorkflowComment({
        issueNumber: options.issueNumber,
        ref,
        workflow: "develop.yml",
        workflowRunUrl: dispatch.html_url,
      }),
    },
    method: "POST",
    path: `/repos/${owner}/${repo}/issues/${options.issueNumber}/comments`,
    token: options.runner.token,
  });
  options.logger.event("github.workflow.dispatch.done", { issue: options.issueNumber });
}

function existingReviewFixLink(
  timeline: TimelineItem[],
  expected: { depth: number; parent: string; root: string },
) {
  return timeline
    .map((item) => reviewFixLinkFromBody(item.body))
    .find(
      (link) =>
        link?.depth === expected.depth &&
        link.parent === expected.parent &&
        link.root === expected.root,
    );
}

function issueUrl(owner: string, repo: string, issueNumber: string): string {
  return `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
}

function queuedReviewFixWorkflowComment(options: {
  issueNumber: string;
  ref: string;
  workflow: string;
  workflowRunUrl?: string;
}): string {
  const run = workflowRunIdFromUrl(options.workflowRunUrl);
  const lines = [
    workflowQueuedMarker({
      artifact: "issue",
      number: options.issueNumber,
      run,
      workflow: options.workflow,
    }),
    "## GitVibe Workflow Queued",
    "",
    `GitVibe queued \`${options.workflow}\` on \`${options.ref}\` for review-fix issue #${options.issueNumber}.`,
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

function arrayField(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
