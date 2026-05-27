import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunAiStageOptions } from "./ai.js";
import { loadConfig } from "./config.js";
import { buildDiscussionContext, buildIssueContext } from "./context.js";
import { GitHubClient } from "../shared/github.js";
import { withStageHandoffs } from "./handoffs.js";
import type { StageLogger } from "./logging.js";
import { createStageLogger } from "./logging.js";
import { renderPrompts } from "./prompts.js";
import { type IssueBranchState, prepareIssueBranch } from "./review-fix.js";
import {
  promptSafetySources,
  runStageResultForMode,
  validationRepairRunner,
} from "./stage-ai-results.js";
import { stageRunResult } from "./stage-results.js";
import { readRoleDefinition } from "./role-groups.js";
import { loadStageSchema } from "./schemas.js";
import type { SafetySource } from "./safety-gate.js";
import { blockUnsafePromptInjection } from "./safety-gate-runner.js";
import {
  applyStageLabelTransition,
  applyStageStartLabelTransition,
  type PublishedArtifactComment,
  publishStageResultComment,
  publishStageStartComment,
} from "./stage-publishing.js";
import {
  blockedPullRequestHeadOutput,
  issueBranchForStage,
  pullRequestHeadBlockReason,
  runnerBaseBranch,
} from "./stage-branches.js";
import { stageContract } from "./stage-dry-run.js";
import { repositoryContext } from "./stage-git.js";
import {
  applyDeterministicWrites,
  markPullRequestFeedbackInvestigationStarted,
} from "./stage-writes.js";
import { stageDefinitions } from "../shared/stages.js";
import type {
  ContextPacket,
  GitVibeConfig,
  JsonObject,
  RunnerOptions,
  StageRunResult,
} from "../shared/types.js";

type RunnerStageDefinition = (typeof stageDefinitions)[RunnerOptions["stage"]];
type StageSafetyOptions = Omit<
  Parameters<typeof blockUnsafePromptInjection>[0],
  "extraSources" | "phase" | "result"
>;

export interface StageSecurityReviewResult {
  allowed: boolean;
  result?: StageRunResult;
  status: string;
  summary: string;
}

export async function runStageSecurityReview(
  options: RunnerOptions,
): Promise<StageSecurityReviewResult> {
  const logger = createStageLogger(options.stage);
  logger.event("security.review.start", {
    dry_run: options.dryRun,
    repository: options.repository,
  });

  const config = loadConfig(options.cwd);
  const definition = stageDefinitions[options.stage];
  const client = new GitHubClient();
  const context = await loadRunnerContext({ client, definition, logger, options });
  const transientComments: PublishedArtifactComment[] = [];
  const blockedHeadResult = await blockUnsafePullRequestHead({
    client,
    context,
    definition,
    logger,
    options,
    transientComments,
  });
  if (blockedHeadResult) return blockedSecurityReview(blockedHeadResult);

  const inputSafetyResult = await blockPromptInput(
    stageSafetyOptions({
      client,
      config,
      context,
      definition,
      logger,
      options,
      transientComments,
    }),
  );
  if (inputSafetyResult) return blockedSecurityReview(inputSafetyResult);

  logger.event("security.review.done", { allowed: true });
  return { allowed: true, status: "allowed", summary: "Security review passed." };
}

export async function runStage(options: RunnerOptions): Promise<StageRunResult> {
  const logger = createStageLogger(options.stage);
  const executionMode = options.executionMode || "standard";
  logger.event("stage.start", {
    dry_run: options.dryRun,
    execution_mode: executionMode,
    max_turns: options.maxTurns,
    repository: options.repository,
  });

  const config = loadConfig(options.cwd);
  const definition = stageDefinitions[options.stage];
  const client = new GitHubClient();
  const context = await loadRunnerContext({ client, definition, logger, options });
  const transientComments = await publishStageStart({ client, context, logger, options });
  const blockedResult = await blockUnsafePullRequestHead({
    client,
    context,
    definition,
    logger,
    options,
    transientComments,
  });
  if (blockedResult) return blockedResult;

  const safetyOptions = stageSafetyOptions({
    client,
    config,
    context,
    definition,
    logger,
    options,
    transientComments,
  });
  const inputSafetyResult = await blockPromptInput(safetyOptions);
  if (inputSafetyResult) return inputSafetyResult;

  const branchState = await prepareBranchForStage({ client, context, logger, options });

  const schema = loadStageSchema(definition.schemaFile);
  const prompts = buildRenderedPrompts({
    branchState: branchState.branchState,
    context,
    definition,
    options,
    schema,
  });
  logger.event("prompt.ready", {
    schema_id: definition.schemaId,
    tools: definition.tools.join(","),
  });

  persistContext({ context, logger, options });

  const aiRunOptions = buildAiRunOptions({
    client,
    config,
    definition,
    logger,
    options,
    prompts,
    schema,
  });
  const promptSafetyResult = await blockPromptInput(safetyOptions, promptSafetySources(prompts));
  if (promptSafetyResult) return promptSafetyResult;

  let result = await runStageResultForMode({
    aiRunOptions,
    config,
    context,
    definition,
    executionMode,
    logger,
    options,
  });
  if (executionMode === "member") {
    return finishStage(logger, result);
  }
  const outputSafetyResult = await blockUnsafePromptInjection({
    ...safetyOptions,
    phase: "output",
    result,
  });
  if (outputSafetyResult) return outputSafetyResult;

  result = await applyDeterministicWrites({
    client,
    config,
    context,
    logger,
    options,
    repair: validationRepairRunner({ aiRunOptions, config, context, definition, logger, options }),
    result,
    runnerBaseBranch: branchState.baseBranch,
    transientComments,
  });

  return finishStage(logger, result);
}

function blockedSecurityReview(result: StageRunResult): StageSecurityReviewResult {
  return {
    allowed: false,
    result,
    status: result.status,
    summary: result.summary,
  };
}

function finishStage(logger: StageLogger, result: StageRunResult): StageRunResult {
  logger.event("stage.done", { status: result.status });
  return result;
}

function persistContext(options: {
  context: ContextPacket;
  logger: StageLogger;
  options: RunnerOptions;
}): void {
  const contextDir = process.env.RUNNER_TEMP || options.options.cwd;
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(
    join(contextDir, `git-vibe-${options.options.stage}-context.json`),
    JSON.stringify(options.context, null, 2),
  );
  options.logger.event("context.persisted", {
    file: `git-vibe-${options.options.stage}-context.json`,
  });
}

function buildAiRunOptions(options: {
  client: GitHubClient;
  config: GitVibeConfig;
  definition: RunnerStageDefinition;
  logger: StageLogger;
  options: RunnerOptions;
  prompts: { prompt: string; system: string };
  schema: JsonObject;
}): RunAiStageOptions {
  return {
    config: options.config,
    cwd: options.options.cwd,
    github: {
      client: options.client,
      repository: options.options.repository,
      token: options.options.token,
    },
    logger: options.logger,
    maxTurns: options.options.maxTurns,
    profileName: options.options.profileName,
    prompt: options.prompts.prompt,
    schema: options.schema,
    schemaId: options.definition.schemaId,
    stage: options.options.stage,
    stageDefinition: options.definition,
    system: options.prompts.system,
  };
}

async function loadRunnerContext(options: {
  client: GitHubClient;
  definition: RunnerStageDefinition;
  logger: StageLogger;
  options: RunnerOptions;
}): Promise<ContextPacket> {
  const prContext =
    (options.options.stage === "review-matrix" || options.options.stage === "investigate") &&
    options.options.prNumber;
  options.logger.event("context.load.start", {
    issue_number: options.options.issueNumber,
    pr_number: options.options.prNumber,
    resolved_target: prContext ? "pull-request" : options.definition.target,
    target: options.definition.target,
  });
  const context = withStageHandoffs(
    withSourceComment(
      await contextFor({ client: options.client, options: options.options }),
      options.options,
    ),
    options.options.handoffDir,
  );
  options.logger.event("context.load.done", {
    artifact: `${context.artifact.type}#${context.artifact.number}`,
    handoffs: context.handoffs?.length || 0,
    timeline_items: context.timeline.length,
  });
  return context;
}

async function publishStageStart(options: {
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  options: RunnerOptions;
}): Promise<PublishedArtifactComment[]> {
  const transientComments: PublishedArtifactComment[] = [];
  if (options.options.executionMode === "member") return transientComments;
  if (!options.options.dryRun && options.options.workflowRunUrl) {
    const comment = await publishStageStartComment({
      client: options.client,
      context: options.context,
      logger: options.logger,
      runner: options.options,
    });
    if (comment) transientComments.push(comment);
  }
  if (!options.options.dryRun) {
    await applyStageStartLabelTransition({
      client: options.client,
      context: options.context,
      logger: options.logger,
      runner: options.options,
    });
  }
  if (
    !options.options.dryRun &&
    options.options.stage === "investigate" &&
    options.context.artifact.type === "pull-request"
  ) {
    await markPullRequestFeedbackInvestigationStarted(options);
  }
  return transientComments;
}

function roleDefinitionFor(options: RunnerOptions): string | undefined {
  if (options.executionMode !== "member" || !options.roleName) return undefined;
  return readRoleDefinition(options.cwd, options.roleName);
}

function buildRenderedPrompts(options: {
  branchState?: IssueBranchState;
  context: ContextPacket;
  definition: RunnerStageDefinition;
  options: RunnerOptions;
  schema: JsonObject;
}): { prompt: string; system: string } {
  return renderPrompts({
    context: options.context,
    cwd: options.options.cwd,
    outputSchema: options.schema,
    promptDir: options.definition.promptDir,
    repositoryContext: repositoryContext(options.options.cwd, options.branchState),
    roleDefinition: roleDefinitionFor(options.options),
    stageContract: stageContract(options.options.stage, options.context),
  });
}

function blockPromptInput(
  options: StageSafetyOptions,
  extraSources?: SafetySource[],
): Promise<StageRunResult | undefined> {
  return blockUnsafePromptInjection({ ...options, extraSources, phase: "input" });
}

function stageSafetyOptions(options: {
  client: GitHubClient;
  config: GitVibeConfig;
  context: ContextPacket;
  definition: RunnerStageDefinition;
  logger: StageLogger;
  options: RunnerOptions;
  transientComments: PublishedArtifactComment[];
}): StageSafetyOptions {
  return {
    buildResult: (content: string) =>
      stageRunResult({
        content,
        context: options.context,
        definition: options.definition,
        logger: options.logger,
        options: options.options,
      }),
    client: options.client,
    config: options.config,
    context: options.context,
    logger: options.logger,
    runner: options.options,
    transientComments: options.transientComments,
  };
}

async function blockUnsafePullRequestHead(options: {
  client: GitHubClient;
  context: ContextPacket;
  definition: (typeof stageDefinitions)[RunnerOptions["stage"]];
  logger: StageLogger;
  options: RunnerOptions;
  transientComments: PublishedArtifactComment[];
}): Promise<StageRunResult | undefined> {
  const reason = pullRequestHeadBlockReason(options.options, options.context);
  if (!reason || options.options.dryRun) return undefined;
  const result = await stageRunResult({
    content: JSON.stringify(blockedPullRequestHeadOutput(options.options.stage, reason)),
    context: options.context,
    definition: options.definition,
    logger: options.logger,
    options: options.options,
  });
  await publishBlockedPullRequestHead({ ...options, result });
  options.logger.event("stage.done", { status: result.status });
  return result;
}

async function publishBlockedPullRequestHead(options: {
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  options: RunnerOptions;
  result: StageRunResult;
  transientComments: PublishedArtifactComment[];
}): Promise<void> {
  await publishStageResultComment({
    client: options.client,
    context: options.context,
    logger: options.logger,
    parsedOutput: options.result.parsedOutput,
    runner: options.options,
    transientComments: options.transientComments,
  });
  await applyStageLabelTransition({
    client: options.client,
    context: options.context,
    logger: options.logger,
    parsedOutput: options.result.parsedOutput,
    runner: options.options,
    transientComments: options.transientComments,
  });
}

async function prepareBranchForStage(options: {
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  options: RunnerOptions;
}): Promise<{
  baseBranch?: Awaited<ReturnType<typeof runnerBaseBranch>>;
  branchState?: IssueBranchState;
}> {
  const branch = issueBranchForStage(options.options.stage, options.context);
  const baseBranch =
    branch && !options.options.dryRun && options.context.artifact.type === "issue"
      ? await runnerBaseBranch({
          client: options.client,
          logger: options.logger,
          options: options.options,
          requireDefault: options.options.stage === "create-pr",
        })
      : undefined;
  const branchState =
    branch && !options.options.dryRun
      ? await prepareIssueBranch({
          baseBranch: baseBranch?.base,
          branch,
          cwd: options.options.cwd,
          logger: options.logger,
          token: options.options.token,
        })
      : undefined;
  return { baseBranch, branchState };
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

  if ((options.stage === "review-matrix" || options.stage === "investigate") && options.prNumber) {
    return buildIssueContext({
      client,
      issueNumber: options.prNumber,
      repository: options.repository,
      token: options.token,
      type: "pull-request",
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
