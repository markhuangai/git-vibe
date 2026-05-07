import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAiStage } from "./ai.js";
import { loadConfig, testCommandsFor } from "./config.js";
import { addDiscussionComment } from "../shared/discussions.js";
import { buildDiscussionContext, buildIssueContext } from "./context.js";
import { GitHubClient, splitRepository } from "../shared/github.js";
import { gitVibeLabels } from "../shared/labels.js";
import { discussionReplyToId } from "./discussion-replies.js";
import { withStageHandoffs, writeStageResultFile } from "./handoffs.js";
import type { StageLogger } from "./logging.js";
import { createStageLogger } from "./logging.js";
import { renderPrompts } from "./prompts.js";
import { renderStageResultComment, type StageResultLink } from "./result-comments.js";
import { loadStageSchema, validateOutput } from "./schemas.js";
import { applyStageLabelTransition, publishStageResultComment } from "./stage-publishing.js";
import {
  buildValidationRepairPrompt,
  runValidationCommand,
  validationRepairAttemptsFor,
  validationRepairMaxTurnsFor,
  type ValidationCommandFailure,
} from "./validation.js";
import { stageDefinitions } from "../shared/stages.js";
import { implementationIssueBody } from "../shared/traceability.js";
import type {
  ContextPacket,
  GitVibeConfig,
  JsonObject,
  RunnerOptions,
  StageRunResult,
} from "../shared/types.js";

export async function runStage(options: RunnerOptions): Promise<StageRunResult> {
  const logger = createStageLogger(options.stage);
  logger.event("stage.start", {
    dry_run: options.dryRun,
    max_turns: options.maxTurns,
    repository: options.repository,
  });

  const config = loadConfig(options.cwd);
  const definition = stageDefinitions[options.stage];
  const client = new GitHubClient();
  logger.event("context.load.start", { target: definition.target });
  const context = withStageHandoffs(
    withSourceComment(await contextFor({ client, options }), options),
    options.handoffDir,
  );
  logger.event("context.load.done", {
    artifact: `${context.artifact.type}#${context.artifact.number}`,
    handoffs: context.handoffs?.length || 0,
    timeline_items: context.timeline.length,
  });

  const schema = loadStageSchema(definition.schemaFile);
  const prompts = renderPrompts({
    context,
    outputSchema: schema,
    promptDir: definition.promptDir,
    repositoryContext: repositoryContext(options.cwd),
    stageContract: stageContract(options.stage, definition.access, context),
  });
  logger.event("prompt.ready", {
    access: definition.access,
    schema_id: definition.schemaId,
    tools: definition.tools.join(","),
  });

  const contextDir = process.env.RUNNER_TEMP || options.cwd;
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(
    join(contextDir, `git-vibe-${options.stage}-context.json`),
    JSON.stringify(context, null, 2),
  );
  logger.event("context.persisted", { file: `git-vibe-${options.stage}-context.json` });

  const aiRunOptions = {
    config,
    cwd: options.cwd,
    logger,
    maxTurns: options.maxTurns,
    prompt: prompts.prompt,
    schema,
    schemaId: definition.schemaId,
    stage: options.stage,
    stageDefinition: definition,
    system: prompts.system,
  };
  const content = options.dryRun
    ? dryRunContent(options.stage, context, logger)
    : await runAiStage(aiRunOptions);
  let result = await stageRunResult({
    content,
    context,
    definition,
    logger,
    options,
  });
  result = await applyDeterministicWrites({
    client,
    config,
    context,
    logger,
    options,
    repair: validationRepairRunner({ aiRunOptions, config, context, definition, logger, options }),
    result,
  });

  logger.event("stage.done", {
    status: result.status,
  });
  return result;
}

function validationRepairRunner({
  aiRunOptions,
  config,
  context,
  definition,
  logger,
  options,
}: {
  aiRunOptions: Parameters<typeof runAiStage>[0];
  config: GitVibeConfig;
  context: ContextPacket;
  definition: (typeof stageDefinitions)[RunnerOptions["stage"]];
  logger: StageLogger;
  options: RunnerOptions;
}) {
  return async (
    failure: ValidationCommandFailure,
    attempt: number,
    maxAttempts: number,
  ): Promise<StageRunResult> =>
    stageRunResult({
      content: await runAiStage({
        ...aiRunOptions,
        maxTurns: validationRepairMaxTurnsFor(config, options),
        prompt: buildValidationRepairPrompt({
          attempt,
          basePrompt: aiRunOptions.prompt,
          cwd: options.cwd,
          failure,
          maxAttempts,
          runner: options,
        }),
      }),
      context,
      definition,
      logger,
      options,
    });
}

async function stageRunResult({
  content,
  context,
  definition,
  logger,
  options,
}: {
  content: string;
  context: ContextPacket;
  definition: (typeof stageDefinitions)[RunnerOptions["stage"]];
  logger: StageLogger;
  options: RunnerOptions;
}): Promise<StageRunResult> {
  logger.event("output.validation.start", { schema_id: definition.schemaId });
  const schema = loadStageSchema(definition.schemaFile);
  const parsedOutput = await validateOutput({ content, schema, schemaId: definition.schemaId });
  logger.event("output.validation.done", {
    status: String(parsedOutput.status || "completed"),
  });
  const result: StageRunResult = {
    commentBody: renderStageResultComment({
      context,
      parsedOutput,
      stage: options.stage,
      workflowRunUrl: options.workflowRunUrl,
    }),
    parsedOutput,
    schemaId: definition.schemaId,
    status: String(parsedOutput.status || "completed"),
    summary: String(parsedOutput.summary || `${options.stage} completed`),
    validationErrors: [],
  };
  const contextDir = process.env.RUNNER_TEMP || options.cwd;
  result.resultFile = writeStageResultFile({
    directory: contextDir,
    result,
    stage: options.stage,
  });
  logger.event("result.persisted", { file: `git-vibe-${options.stage}-result.json` });
  return result;
}

async function contextFor({
  client,
  options,
}: {
  client: GitHubClient;
  options: RunnerOptions;
}): Promise<ContextPacket> {
  const definition = stageDefinitions[options.stage];
  if (
    options.stage === "validate" &&
    process.env.GITVIBE_DISCUSSION_NUMBER &&
    !options.issueNumber
  ) {
    return buildDiscussionContext({
      client,
      discussionNumber: process.env.GITVIBE_DISCUSSION_NUMBER,
      repository: options.repository,
      token: options.token,
    });
  }

  if (definition.target === "discussion") {
    const discussionNumber = process.env.GITVIBE_DISCUSSION_NUMBER || options.issueNumber;
    return buildDiscussionContext({
      client,
      discussionNumber,
      repository: options.repository,
      token: options.token,
    });
  }

  return buildIssueContext({
    client,
    issueNumber: definition.target === "pull-request" ? options.prNumber : options.issueNumber,
    repository: options.repository,
    token: options.token,
    type: definition.target,
  });
}

function withSourceComment(context: ContextPacket, options: RunnerOptions): ContextPacket {
  if (!options.sourceComment) return context;
  return { ...context, source: { ...(context.source || {}), comment: options.sourceComment } };
}

async function applyDeterministicWrites(options: {
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
}): Promise<StageRunResult> {
  if (options.options.dryRun) {
    options.logger.event("writes.skip", { reason: "dry-run" });
    return options.result;
  }

  const status = options.result.status;
  if (status !== "completed") {
    await publishStageResultComment({
      ...options,
      parsedOutput: options.result.parsedOutput,
      runner: options.options,
    });
    await applyStageLabelTransition({
      ...options,
      parsedOutput: options.result.parsedOutput,
      runner: options.options,
    });
    options.logger.event("writes.skip", { reason: "status", status });
    return options.result;
  }

  if (stageDefinitions[options.options.stage].access === "read-only") {
    await publishStageResultComment({
      ...options,
      parsedOutput: options.result.parsedOutput,
      runner: options.options,
    });
    await applyStageLabelTransition({
      ...options,
      parsedOutput: options.result.parsedOutput,
      runner: options.options,
    });
    return options.result;
  }

  if (options.options.stage === "implement") {
    await applyStageLabelTransition({
      ...options,
      parsedOutput: options.result.parsedOutput,
      runner: options.options,
    });
    return commitImplementation(options);
  }
  if (options.options.stage === "materialize")
    await createImplementationIssue({
      ...options,
      parsedOutput: options.result.parsedOutput,
    });
  if (options.options.stage === "create-pr") {
    const pullRequest = await createPullRequest({
      ...options,
      parsedOutput: options.result.parsedOutput,
    });
    await publishStageResultComment({
      ...options,
      links: pullRequestLinks(pullRequest),
      parsedOutput: options.result.parsedOutput,
      runner: options.options,
    });
    await applyStageLabelTransition({
      ...options,
      parsedOutput: options.result.parsedOutput,
      runner: options.options,
    });
  }
  if (options.options.stage === "address-pr-feedback") {
    const result = await commitImplementation(options);
    if (result.status === "completed")
      await publishStageResultComment({
        ...options,
        parsedOutput: result.parsedOutput,
        runner: options.options,
      });
    return result;
  }
  return options.result;
}

async function commitImplementation({
  client,
  config,
  context,
  logger,
  options,
  repair,
  result,
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
}): Promise<StageRunResult> {
  const branch = branchName(context.artifact.number);
  logger.event("git.branch.checkout", { branch });
  execFileSync("git", ["checkout", "-B", branch], { cwd: options.cwd, stdio: "inherit" });
  const finalResult = await runValidationWithRepair({ config, logger, options, repair, result });
  if (finalResult.status !== "completed") {
    await publishStageResultComment({
      client,
      context,
      logger,
      parsedOutput: finalResult.parsedOutput,
      runner: options,
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
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: options.cwd })
    .toString()
    .trim();
  if (!status) {
    logger.event("git.no_changes");
    return finalResult;
  }
  logger.event("git.status.changed", { files: summarizeGitStatus(status) });

  ensureGitIdentity(options.cwd);
  logger.event("git.commit.start");
  execFileSync("git", ["add", "-A"], { cwd: options.cwd, stdio: "inherit" });
  execFileSync("git", ["commit", "-m", `Implement #${context.artifact.number} with GitVibe`], {
    cwd: options.cwd,
    stdio: "inherit",
  });
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: options.cwd })
    .toString()
    .trim();
  logger.event("git.commit.done", { commit });
  logger.event("token.use", {
    access: "branch-write",
  });
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
  return finalResult;
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
  logger.event("token.use", {
    access: "publish-write",
  });
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
  }
}

async function createPullRequest({
  client,
  config,
  context,
  logger,
  options,
  parsedOutput,
}: {
  client: GitHubClient;
  config: GitVibeConfig;
  context: ContextPacket;
  logger: StageLogger;
  options: RunnerOptions;
  parsedOutput: JsonObject;
}): Promise<{ html_url?: string; number?: number }> {
  logger.event("token.use", {
    access: "publish-write",
  });
  const { owner, repo } = splitRepository(options.repository);
  const head = branchName(context.artifact.number);
  const title = String(parsedOutput.pr_title || `GitVibe: ${context.artifact.title}`);
  const body = String(
    parsedOutput.pr_body || `${parsedOutput.summary || ""}\n\nRefs #${context.artifact.number}`,
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
  const base = config.branches?.base || undefined;
  logger.event("github.pr.create.start", { base: base || "repository-default", head });
  const pullRequest = await client.request<{ html_url?: string; number?: number }>({
    body: {
      base,
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

function ensureGitIdentity(cwd: string): void {
  setGitConfigIfMissing(cwd, "user.name", "git-vibe");
  setGitConfigIfMissing(cwd, "user.email", "git-vibe@users.noreply.github.com");
}

function setGitConfigIfMissing(cwd: string, key: string, value: string): void {
  try {
    const existing = execFileSync("git", ["config", "--get", key], { cwd }).toString().trim();
    if (existing) return;
  } catch {
    // Missing config is expected on fresh runners.
  }

  execFileSync("git", ["config", key, value], { cwd, stdio: "inherit" });
}

function repositoryContext(cwd: string): string {
  return execFileSync("git", ["status", "--short", "--branch"], { cwd }).toString();
}

function summarizeGitStatus(status: string): string {
  const lines = status.split("\n").filter(Boolean);
  const visible = lines.slice(0, 12).join("; ");
  if (lines.length <= 12) return visible;
  return `${visible}; ... +${lines.length - 12} more`;
}

function stageContract(stage: string, access: string, context: ContextPacket): string {
  const deterministicBranch = issueBranchForStage(stage, context);
  const branchRule = deterministicBranch
    ? ` GitVibe owns branch selection; use ${deterministicBranch} exactly and do not invent a branch name.`
    : "";
  return `Stage ${stage} has ${access} access.${branchRule} Return only JSON matching the schema. Call output_validator with the exact final JSON before responding.`;
}

function issueBranchForStage(stage: string, context: ContextPacket): string | undefined {
  if (
    context.artifact.type === "issue" &&
    ["implement", "review-matrix", "create-pr"].includes(stage)
  ) {
    return branchName(context.artifact.number);
  }

  return undefined;
}

function dryRunOutput(stage: string, context: ContextPacket): JsonObject {
  const base = {
    assumptions: [],
    comment_body: `GitVibe dry run for ${stage} on ${context.artifact.type} #${context.artifact.number}.`,
    findings: [],
    next_state: "dry-run",
    references: [context.artifact.url].filter(Boolean),
    stage,
    status: "completed",
    summary: `Dry run completed for ${stage}.`,
  };

  if (stage === "create-pr") {
    return {
      ...base,
      branch: branchName(context.artifact.number),
      pr_body: `Dry-run pull request for ${context.artifact.url}`,
      pr_title: `GitVibe dry run: ${context.artifact.title}`,
    };
  }

  if (stage === "materialize") {
    return {
      ...base,
      issue_body: `Dry-run implementation issue for ${context.artifact.url}`,
      issue_title: `GitVibe dry run: ${context.artifact.title}`,
    };
  }

  if (stage === "implement") {
    return {
      ...base,
      tests: [],
    };
  }

  if (stage === "address-pr-feedback") {
    return {
      ...base,
      skipped_feedback: [],
      tests: [],
    };
  }

  return base;
}

function dryRunContent(stage: string, context: ContextPacket, logger: StageLogger): string {
  logger.event("ai.skip", { reason: "dry-run" });
  return JSON.stringify(dryRunOutput(stage, context));
}

function branchName(number: string): string {
  const issueNumber = number.trim();
  if (!/^[1-9]\d*$/.test(issueNumber)) {
    throw new Error(`GitVibe branch requires a numeric issue number, got ${number || "<missing>"}`);
  }

  return `git-vibe/${issueNumber}`;
}
