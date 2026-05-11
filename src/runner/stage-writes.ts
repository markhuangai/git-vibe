import { execFileSync } from "node:child_process";
import { testCommandsFor } from "./config.js";
import { addDiscussionComment, closeDiscussion } from "../shared/discussions.js";
import { GitHubClient, splitRepository } from "../shared/github.js";
import { equivalentGitVibeLabelNames, gitVibeLabels } from "../shared/labels.js";
import { discussionReplyToId } from "./discussion-replies.js";
import {
  ensureGitIdentity,
  summarizeGitStatus,
  summarizePaths,
  unstageRuntimeArtifactChanges,
} from "./stage-git.js";
import type { StageLogger } from "./logging.js";
import {
  appendIssueTraceability,
  handleReviewFixRequired,
  issueBranch,
  issueChain,
} from "./review-fix.js";
import type { StageResultLink } from "./result-comments.js";
import {
  applyStageLabelTransition,
  cleanupStageStatusComments,
  type PublishedArtifactComment,
  publishFeedbackInvestigationReplies,
  publishStageResultComment,
} from "./stage-publishing.js";
import { branchForWriteStage, runnerBaseBranch, type BaseBranchState } from "./stage-branches.js";
import { runValidationCommand, validationRepairAttemptsFor } from "./validation.js";
import type { ValidationCommandFailure } from "./validation.js";
import { implementationIssueBody, reviewFixTraceFromBody } from "../shared/traceability.js";
import { maybeHandlePullRequestReviewFixRequired } from "./pr-feedback-review-fix.js";
import type {
  ContextPacket,
  GitVibeConfig,
  JsonObject,
  RunnerOptions,
  Stage,
  StageRunResult,
} from "../shared/types.js";

type DeterministicWriteOptions = {
  runnerBaseBranch?: BaseBranchState;
  client: GitHubClient;
  config: GitVibeConfig;
  context: ContextPacket;
  logger: StageLogger;
  options: RunnerOptions;
  repair: (
    failure: ValidationCommandFailure,
    attempt: number,
    maxAttempts: number,
  ) => Promise<StageRunResult>;
  result: StageRunResult;
  transientComments: PublishedArtifactComment[];
};

export async function applyDeterministicWrites(
  options: DeterministicWriteOptions,
): Promise<StageRunResult> {
  if (options.options.dryRun) {
    options.logger.event("writes.skip", { reason: "dry-run" });
    return options.result;
  }

  if (options.result.status !== "completed") return publishBlockedResult(options);
  const reviewFixResult = await maybeHandleReviewFixRequired(options);
  if (reviewFixResult) return reviewFixResult;
  const pullRequestReviewFixResult = await maybeHandlePullRequestReviewFixRequired({
    ...options,
    runner: options.options,
  });
  if (pullRequestReviewFixResult) return pullRequestReviewFixResult;

  if (!isWriteStage(options.options.stage)) {
    return publishReadOnlyResult(options);
  }

  return applyWriteStage(options);
}

function isWriteStage(stage: Stage): boolean {
  return ["materialize", "implement", "create-pr", "address-pr-feedback"].includes(stage);
}

async function publishBlockedResult(options: DeterministicWriteOptions): Promise<StageRunResult> {
  await publishStageResultComment({
    ...options,
    parsedOutput: options.result.parsedOutput,
    runner: options.options,
    transientComments: options.transientComments,
  });
  await applyStageLabelTransition({
    ...options,
    parsedOutput: options.result.parsedOutput,
    runner: options.options,
    transientComments: options.transientComments,
  });
  options.logger.event("writes.skip", { reason: "status", status: options.result.status });
  return options.result;
}

async function maybeHandleReviewFixRequired(
  options: DeterministicWriteOptions,
): Promise<StageRunResult | undefined> {
  if (
    options.options.stage !== "review-matrix" ||
    options.context.artifact.type !== "issue" ||
    !isReviewChangesRequired(options.result.parsedOutput)
  ) {
    return undefined;
  }

  await cleanupStageStatusComments({
    client: options.client,
    context: options.context,
    logger: options.logger,
    runner: options.options,
    transientComments: options.transientComments,
  });
  return handleReviewFixRequired({
    client: options.client,
    config: options.config,
    context: options.context,
    logger: options.logger,
    result: options.result,
    runner: options.options,
  });
}

async function publishReadOnlyResult(options: DeterministicWriteOptions): Promise<StageRunResult> {
  if (options.options.stage === "investigate" && options.context.artifact.type === "pull-request") {
    await publishFeedbackInvestigationReplies({
      ...options,
      parsedOutput: options.result.parsedOutput,
      runner: options.options,
    });
  }
  await publishStageResultComment({
    ...options,
    parsedOutput: options.result.parsedOutput,
    runner: options.options,
    transientComments: options.transientComments,
  });
  await applyStageLabelTransition({
    ...options,
    parsedOutput: options.result.parsedOutput,
    runner: options.options,
  });
  return options.result;
}

async function applyWriteStage(options: DeterministicWriteOptions): Promise<StageRunResult> {
  if (options.options.stage === "implement") return transitionAndCommit(options);
  if (options.options.stage === "materialize")
    await createImplementationIssue({ ...options, parsedOutput: options.result.parsedOutput });
  if (options.options.stage === "create-pr") await publishPullRequestUpdate(options);
  if (options.options.stage === "address-pr-feedback") return addressPullRequestFeedback(options);
  return options.result;
}

async function transitionAndCommit(options: DeterministicWriteOptions): Promise<StageRunResult> {
  await applyStageLabelTransition({
    ...options,
    parsedOutput: options.result.parsedOutput,
    runner: options.options,
  });
  return commitImplementation(options);
}

async function publishPullRequestUpdate(options: DeterministicWriteOptions): Promise<void> {
  const pullRequest = await createPullRequest({
    ...options,
    baseBranch: options.runnerBaseBranch,
    parsedOutput: options.result.parsedOutput,
  });
  await markPullRequestReadyForApproval({
    client: options.client,
    logger: options.logger,
    pullRequest,
    runner: options.options,
  });
  await publishStageResultComment({
    ...options,
    links: pullRequestLinks(pullRequest),
    parsedOutput: options.result.parsedOutput,
    runner: options.options,
    transientComments: options.transientComments,
  });
  await applyStageLabelTransition({
    ...options,
    parsedOutput: options.result.parsedOutput,
    runner: options.options,
  });
}

async function addressPullRequestFeedback(
  options: DeterministicWriteOptions,
): Promise<StageRunResult> {
  await applyStageLabelTransition({
    ...options,
    parsedOutput: options.result.parsedOutput,
    runner: options.options,
  });
  const result = await commitImplementation(options);
  if (result.status === "completed")
    await publishStageResultComment({
      ...options,
      parsedOutput: result.parsedOutput,
      runner: options.options,
      transientComments: options.transientComments,
    });
  return result;
}

export async function markPullRequestFeedbackInvestigationStarted(options: {
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  options: RunnerOptions;
}): Promise<void> {
  if (options.context.artifact.type !== "pull-request") return;
  await removeEquivalentRunnerIssueLabels({
    client: options.client,
    issueNumber: options.context.artifact.number,
    label: gitVibeLabels.readyForApproval.name,
    logger: options.logger,
    runner: options.options,
  });
  await removeEquivalentRunnerIssueLabels({
    client: options.client,
    issueNumber: options.context.artifact.number,
    label: gitVibeLabels.blocked.name,
    logger: options.logger,
    runner: options.options,
  });
  await addRunnerIssueLabel({
    client: options.client,
    issueNumber: options.context.artifact.number,
    label: gitVibeLabels.investigating.name,
    logger: options.logger,
    runner: options.options,
  });
}

async function commitImplementation({
  client,
  config,
  context,
  logger,
  options,
  repair,
  result,
  transientComments,
}: {
  client: GitHubClient;
  config: GitVibeConfig;
  context: ContextPacket;
  logger: StageLogger;
  options: RunnerOptions;
  repair: (
    failure: ValidationCommandFailure,
    attempt: number,
    maxAttempts: number,
  ) => Promise<StageRunResult>;
  result: StageRunResult;
  transientComments: PublishedArtifactComment[];
}): Promise<StageRunResult> {
  const branch = branchForWriteStage(options.stage, context);
  const finalResult = await runValidationWithRepair({ config, logger, options, repair, result });
  if (finalResult.status !== "completed") {
    await publishStageResultComment({
      client,
      context,
      logger,
      parsedOutput: finalResult.parsedOutput,
      runner: options,
      transientComments,
    });
    await applyStageLabelTransition({
      client,
      context,
      logger,
      parsedOutput: finalResult.parsedOutput,
      runner: options,
    });
    logger.event("writes.skip", { reason: "status", status: finalResult.status });
    return finalResult;
  }
  logger.event("tests.done");
  if (!commitAndPushChanges({ branch, context, logger, options })) return finalResult;
  return finalResult;
}

function commitAndPushChanges(options: {
  branch: string;
  context: ContextPacket;
  logger: StageLogger;
  options: RunnerOptions;
}): boolean {
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: options.options.cwd })
    .toString()
    .trim();
  if (!status) {
    options.logger.event("git.no_changes");
    return false;
  }
  options.logger.event("git.status.changed", { files: summarizeGitStatus(status) });

  if (!stageChangedFiles(options.options.cwd, options.logger)) return false;
  createGitCommit(options.context, options.options);
  pushGitBranch(options.branch, options.logger, options.options);
  return true;
}

function stageChangedFiles(cwd: string, logger: StageLogger): boolean {
  ensureGitIdentity(cwd);
  logger.event("git.commit.start");
  execFileSync("git", ["add", "-A"], { cwd, stdio: "inherit" });
  const unstagedRuntimeArtifacts = unstageRuntimeArtifactChanges(cwd);
  if (unstagedRuntimeArtifacts.length > 0) {
    logger.event("git.runtime_artifacts.unstaged", {
      files: summarizePaths(unstagedRuntimeArtifacts),
    });
  }
  const stagedStatus = execFileSync("git", ["diff", "--cached", "--name-status"], {
    cwd,
  })
    .toString()
    .trim();
  if (stagedStatus) return true;
  logger.event("git.no_staged_changes");
  return false;
}

function createGitCommit(context: ContextPacket, options: RunnerOptions): void {
  execFileSync(
    "git",
    [
      "commit",
      "-m",
      `Implement #${context.artifact.number} with GitVibe`,
      "-m",
      `Closes #${rootIssueNumber(context)}`,
    ],
    { cwd: options.cwd, stdio: "inherit" },
  );
}

function pushGitBranch(branch: string, logger: StageLogger, options: RunnerOptions): void {
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: options.cwd })
    .toString()
    .trim();
  logger.event("git.commit.done", { commit });
  logger.event("token.use");
  logger.event("git.push.start", { branch });
  execFileSync(
    "git",
    [
      "-c",
      `http.extraheader=AUTHORIZATION: bearer ${options.token}`,
      "push",
      `https://github.com/${options.repository}.git`,
      branch,
    ],
    { cwd: options.cwd, stdio: "inherit" },
  );
  logger.event("git.push.done", { branch });
}

async function runValidationWithRepair({
  config,
  logger,
  options,
  repair,
  result,
}: {
  config: GitVibeConfig;
  logger: StageLogger;
  options: RunnerOptions;
  repair: (
    failure: ValidationCommandFailure,
    attempt: number,
    maxAttempts: number,
  ) => Promise<StageRunResult>;
  result: StageRunResult;
}): Promise<StageRunResult> {
  const maxAttempts = validationRepairAttemptsFor(config, options);
  let current = result;

  for (let attempt = 0; ; attempt += 1) {
    try {
      runValidationCommands(config, logger, options.cwd);
      return current;
    } catch (error) {
      if (!(error instanceof Error && "failure" in error)) throw error;
      const failure = (error as { failure: ValidationCommandFailure }).failure;
      if (attempt >= maxAttempts) {
        logger.event("tests.repair.exhausted", {
          attempts: maxAttempts,
          command: failure.command,
        });
        throw error;
      }

      logger.event("tests.repair.start", {
        attempt: attempt + 1,
        command: failure.command,
        max_attempts: maxAttempts,
      });
      current = await repair(failure, attempt + 1, maxAttempts);
      if (current.status !== "completed") return current;
      logger.event("tests.repair.done", { attempt: attempt + 1, status: current.status });
    }
  }
}

function runValidationCommands(config: GitVibeConfig, logger: StageLogger, cwd: string): void {
  for (const command of testCommandsFor(config)) {
    logger.event("tests.run", { command });
    runValidationCommand(cwd, command);
  }
}

async function createImplementationIssue({
  client,
  context,
  logger,
  options,
  parsedOutput,
}: {
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  options: RunnerOptions;
  parsedOutput: JsonObject;
}): Promise<void> {
  logger.event("token.use");
  const { owner, repo } = splitRepository(options.repository);
  logger.event("github.issue.create.start");
  const issueBody = implementationIssueBody({
    discussionNumber: context.artifact.number,
    discussionUrl: context.artifact.url,
    issueBody: String(parsedOutput.issue_body || ""),
  });
  const issue = await client.request<{ html_url?: string; number?: number }>({
    body: {
      body: issueBody,
      labels: [gitVibeLabels.story.name],
      title: String(parsedOutput.issue_title || `Implement: ${context.artifact.title}`),
    },
    method: "POST",
    path: `/repos/${owner}/${repo}/issues`,
    token: options.token,
  });
  logger.event("github.issue.create.done", { number: issue.number, url: issue.html_url });
  if (context.artifact.id && issue.html_url) {
    logger.event("github.discussion.comment.start", { discussion: context.artifact.number });
    await addDiscussionComment({
      body: `GitVibe created implementation issue #${issue.number}: ${issue.html_url}`,
      client,
      discussionId: context.artifact.id,
      replyToId: discussionReplyToId(options, context),
      token: options.token,
    });
    logger.event("github.discussion.comment.done", { discussion: context.artifact.number });
    await closeSourceDiscussion({
      client,
      discussionId: context.artifact.id,
      logger,
      number: context.artifact.number,
      runner: options,
    });
  }
}

async function closeSourceDiscussion(options: {
  client: GitHubClient;
  discussionId: string;
  logger: StageLogger;
  number: string;
  runner: RunnerOptions;
}): Promise<void> {
  options.logger.event("github.discussion.close.start", { discussion: options.number });
  try {
    await closeDiscussion({
      client: options.client,
      discussionId: options.discussionId,
      token: options.runner.token,
    });
    options.logger.event("github.discussion.close.done", { discussion: options.number });
  } catch (error) {
    options.logger.event("github.discussion.close.failed", {
      discussion: options.number,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function createPullRequest({
  baseBranch,
  client,
  context,
  logger,
  options,
  parsedOutput,
}: {
  baseBranch?: BaseBranchState;
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  options: RunnerOptions;
  parsedOutput: JsonObject;
}): Promise<{ html_url?: string; number?: number }> {
  logger.event("token.use");
  const { owner, repo } = splitRepository(options.repository);
  const head = issueBranch(context);
  const title = String(parsedOutput.pr_title || `GitVibe: ${context.artifact.title}`);
  const pullRequestBase =
    baseBranch ||
    (await runnerBaseBranch({
      client,
      logger,
      options,
    }));
  const body = appendIssueTraceability(
    String(parsedOutput.pr_body || parsedOutput.summary || ""),
    await issueChain({ client, context, runner: options }),
    { closingKeywords: pullRequestBase.targetsDefault },
  );
  logger.event("github.pr.lookup", { head });
  const existing = await client.request<Array<{ number?: number }>>({
    method: "GET",
    path: `/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(head)}&state=open&per_page=1`,
    token: options.token,
  });
  if (existing[0]?.number) {
    logger.event("github.pr.lookup.done", { found: true, number: existing[0].number });
    logger.event("github.pr.update.start", { number: existing[0].number });
    const updated = await client.request<{ html_url?: string; number?: number }>({
      body: { body, title },
      method: "PATCH",
      path: `/repos/${owner}/${repo}/pulls/${existing[0].number}`,
      token: options.token,
    });
    logger.event("github.pr.update.done", { number: updated.number, url: updated.html_url });
    return updated;
  }

  logger.event("github.pr.lookup.done", { found: false });
  logger.event("github.pr.create.start", { base: pullRequestBase.base, head });
  const pullRequest = await client.request<{ html_url?: string; number?: number }>({
    body: {
      base: pullRequestBase.base,
      body,
      head,
      title,
    },
    method: "POST",
    path: `/repos/${owner}/${repo}/pulls`,
    token: options.token,
  });
  logger.event("github.pr.create.done", { number: pullRequest.number, url: pullRequest.html_url });
  return pullRequest;
}

function pullRequestLinks(pullRequest: { html_url?: string; number?: number }): StageResultLink[] {
  if (!pullRequest.html_url) return [];
  const suffix = pullRequest.number ? ` #${pullRequest.number}` : "";
  return [{ label: `Pull request${suffix}`, url: pullRequest.html_url }];
}

async function markPullRequestReadyForApproval(options: {
  client: GitHubClient;
  logger: StageLogger;
  pullRequest: { number?: number };
  runner: RunnerOptions;
}): Promise<void> {
  if (!options.pullRequest.number) {
    options.logger.event("github.pr.label.skip", { reason: "missing-pr-number" });
    return;
  }
  const { owner, repo } = splitRepository(options.runner.repository);
  options.logger.event("github.pr.label.start", {
    label: gitVibeLabels.readyForApproval.name,
    pull_request: String(options.pullRequest.number),
  });
  await options.client.request({
    body: { labels: [gitVibeLabels.readyForApproval.name] },
    method: "POST",
    path: `/repos/${owner}/${repo}/issues/${options.pullRequest.number}/labels`,
    token: options.runner.token,
  });
  options.logger.event("github.pr.label.done", {
    label: gitVibeLabels.readyForApproval.name,
    pull_request: String(options.pullRequest.number),
  });
}

async function addRunnerIssueLabel(options: {
  client: GitHubClient;
  issueNumber: string;
  label: string;
  logger: StageLogger;
  runner: RunnerOptions;
}): Promise<void> {
  const { owner, repo } = splitRepository(options.runner.repository);
  options.logger.event("github.issue.label.start", {
    issue: options.issueNumber,
    label: options.label,
  });
  await options.client.request({
    body: { labels: [options.label] },
    method: "POST",
    path: `/repos/${owner}/${repo}/issues/${options.issueNumber}/labels`,
    token: options.runner.token,
  });
  options.logger.event("github.issue.label.done", {
    issue: options.issueNumber,
    label: options.label,
  });
}

async function removeRunnerIssueLabelIfPresent(options: {
  client: GitHubClient;
  issueNumber: string;
  label: string;
  logger: StageLogger;
  runner: RunnerOptions;
}): Promise<void> {
  const { owner, repo } = splitRepository(options.runner.repository);
  try {
    await options.client.request({
      method: "DELETE",
      path: `/repos/${owner}/${repo}/issues/${options.issueNumber}/labels/${encodeURIComponent(options.label)}`,
      token: options.runner.token,
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

async function removeEquivalentRunnerIssueLabels(options: {
  client: GitHubClient;
  issueNumber: string;
  label: string;
  logger: StageLogger;
  runner: RunnerOptions;
}): Promise<void> {
  for (const label of equivalentGitVibeLabelNames(options.label)) {
    await removeRunnerIssueLabelIfPresent({ ...options, label });
  }
}

function rootIssueNumber(context: ContextPacket): string {
  return reviewFixTraceFromBody(context.artifact.body)?.root || context.artifact.number;
}

function isReviewChangesRequired(output: JsonObject): boolean {
  return (
    String(output.next_state || "")
      .trim()
      .toLowerCase()
      .replaceAll("_", "-") === "changes-required"
  );
}
