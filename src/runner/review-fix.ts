import { execFileSync } from "node:child_process";
import { GitHubClient, splitRepository } from "../shared/github.js";
import { gitVibeInternalLabels } from "../shared/labels.js";
import {
  gitVibeBranchName,
  reviewFixIssueBody,
  reviewFixLinkComment,
  reviewFixLinkFromBody,
  reviewFixTraceFromBody,
} from "../shared/traceability.js";
import type { StageLogger } from "./logging.js";
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
  branch: string;
  cwd: string;
  logger: StageLogger;
  token: string;
}): Promise<IssueBranchState> {
  const remoteRef = `refs/remotes/origin/${options.branch}`;
  options.logger.event("git.branch.prepare", { branch: options.branch });
  try {
    execFileSync(
      "git",
      [
        "-c",
        `http.extraheader=AUTHORIZATION: bearer ${options.token}`,
        "fetch",
        "origin",
        `refs/heads/${options.branch}:${remoteRef}`,
      ],
      { cwd: options.cwd, stdio: "ignore" },
    );
    execFileSync("git", ["checkout", "-B", options.branch, remoteRef], {
      cwd: options.cwd,
      stdio: "inherit",
    });
    return { branch: options.branch, remoteFound: true };
  } catch {
    execFileSync("git", ["checkout", "-B", options.branch], {
      cwd: options.cwd,
      stdio: "inherit",
    });
    return { branch: options.branch, remoteFound: false };
  }
}

export function issueBranch(context: ContextPacket): string {
  return (
    reviewFixTraceFromBody(context.artifact.body)?.branch ||
    gitVibeBranchName(context.artifact.number)
  );
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
  const maxDepth = reviewMaxIterationsFor(options.config);
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

function reviewMaxIterationsFor(config: GitVibeConfig): number {
  return positiveInteger(configNumber(config.ai?.budgets, "review_max_iterations"), 5);
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
  issueNumber: string;
  logger: StageLogger;
  runner: RunnerOptions;
}): Promise<void> {
  if (!options.issueNumber)
    throw new Error("Cannot dispatch review-fix workflow without an issue number.");
  const { owner, repo } = splitRepository(options.runner.repository);
  options.logger.event("github.workflow.dispatch.start", { issue: options.issueNumber });
  await options.client.request({
    body: {
      inputs: { "issue-number": options.issueNumber },
      ref: process.env.GITVIBE_DISPATCH_REF || process.env.GITHUB_REF_NAME || "main",
    },
    method: "POST",
    path: `/repos/${owner}/${repo}/actions/workflows/develop.yml/dispatches`,
    token: options.runner.token,
  });
  await options.client.request({
    body: {
      body: queuedReviewFixWorkflowComment({
        issueNumber: options.issueNumber,
        ref: process.env.GITVIBE_DISPATCH_REF || process.env.GITHUB_REF_NAME || "main",
        workflow: "develop.yml",
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
}): string {
  return [
    `<!-- git-vibe:workflow-queued workflow=${options.workflow} artifact=issue number=${options.issueNumber} -->`,
    "## GitVibe Workflow Queued",
    "",
    `GitVibe queued \`${options.workflow}\` on \`${options.ref}\` for review-fix issue #${options.issueNumber}.`,
    "The runner will post again when the stage starts.",
  ].join("\n");
}

function arrayField(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(...values: Array<number | undefined>): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  }
  return 1;
}

function configNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" ? field : undefined;
}
