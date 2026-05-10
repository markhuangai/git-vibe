import { baseBranchFromEnv } from "./config.js";
import type { StageLogger } from "./logging.js";
import { issueBranch } from "./review-fix.js";
import { GitHubClient, repositoryDefaultBranch, splitRepository } from "../shared/github.js";
import { reviewFixTraceFromBody } from "../shared/traceability.js";
import type { ContextPacket, JsonObject, RunnerOptions } from "../shared/types.js";

export interface BaseBranchState {
  base: string;
  defaultBranch: string;
  targetsDefault: boolean;
}

export async function runnerBaseBranch(options: {
  client: GitHubClient;
  logger: StageLogger;
  options: RunnerOptions;
  requireDefault?: boolean;
}): Promise<BaseBranchState> {
  const { owner, repo } = splitRepository(options.options.repository);
  const configured = baseBranchFromEnv();
  if (configured && !options.requireDefault) {
    return { base: configured, defaultBranch: "", targetsDefault: false };
  }
  options.logger.event("github.repository.lookup", { owner, repo });
  const defaultBranch = await repositoryDefaultBranch({
    client: options.client,
    owner,
    repo,
    token: options.options.token,
  });
  const base = configured || defaultBranch;
  options.logger.event("github.repository.lookup.done", {
    base,
    default_branch: defaultBranch,
  });
  return { base, defaultBranch, targetsDefault: base === defaultBranch };
}

export function issueBranchForStage(stage: string, context: ContextPacket): string | undefined {
  if (
    context.artifact.type === "pull-request" &&
    ["address-pr-feedback", "investigate", "review-matrix"].includes(stage)
  ) {
    return pullRequestHeadBranch(context);
  }
  if (context.artifact.type !== "issue") return undefined;
  if (["implement", "review-matrix", "create-pr"].includes(stage)) {
    return issueBranch(context);
  }
  if (stage === "investigate" && reviewFixTraceFromBody(context.artifact.body)) {
    return issueBranch(context);
  }

  return undefined;
}

export function branchForWriteStage(stage: string, context: ContextPacket): string {
  if (stage === "address-pr-feedback") {
    const branch = pullRequestHeadBranch(context);
    if (!branch)
      throw new Error("address-pr-feedback requires a writable pull request head branch.");
    return branch;
  }
  return issueBranch(context);
}

export function pullRequestHeadBlockReason(
  options: RunnerOptions,
  context: ContextPacket,
): string | undefined {
  if (
    context.artifact.type !== "pull-request" ||
    !["address-pr-feedback", "investigate", "review-matrix"].includes(options.stage)
  ) {
    return undefined;
  }
  const head = context.artifact.pullRequestHead;
  if (!head?.branch || !head.repository) {
    return "GitVibe could not resolve the pull request head branch.";
  }
  if (head.repository !== options.repository) {
    return `GitVibe cannot safely push feedback changes to pull request head ${head.repository}:${head.branch}.`;
  }
  return undefined;
}

export function blockedPullRequestHeadOutput(
  stage: RunnerOptions["stage"],
  reason: string,
): JsonObject {
  const base = {
    assumptions: [],
    comment_body: reason,
    findings: [reason],
    next_state: "blocked",
    references: [],
    stage,
    status: "blocked",
    summary: "GitVibe could not prepare the pull request branch.",
  };
  if (stage === "investigate") {
    return {
      ...base,
      blocking_questions: [reason],
      feedback_items: [],
      implementation_plan: [],
      questions: [],
    };
  }
  if (stage === "address-pr-feedback") {
    return { ...base, skipped_feedback: [], tests: [] };
  }
  return base;
}

function pullRequestHeadBranch(context: ContextPacket): string | undefined {
  if (context.artifact.type !== "pull-request") return undefined;
  return context.artifact.pullRequestHead?.branch;
}
