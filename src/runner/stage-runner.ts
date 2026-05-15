import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAiStage, type RunAiStageOptions } from "./ai.js";
import { loadConfig } from "./config.js";
import { buildDiscussionContext, buildIssueContext } from "./context.js";
import { GitHubClient } from "../shared/github.js";
import { withStageHandoffs, writeStageResultFile, writeStageResultSummary } from "./handoffs.js";
import type { StageLogger } from "./logging.js";
import { createStageLogger, summarizeError } from "./logging.js";
import { renderPrompts } from "./prompts.js";
import { issueBranch, type IssueBranchState, prepareIssueBranch } from "./review-fix.js";
import { renderStageResultComment } from "./result-comments.js";
import {
  loadMatrixStageResults,
  matrixResultMetadata,
  readRoleDefinition,
  stageExecutionPlan,
  synthesisPromptAddition,
  synthesizerSystemAddition,
} from "./role-groups.js";
import { loadStageSchema, validateOutput } from "./schemas.js";
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
import { dryRunContent, stageContract } from "./stage-dry-run.js";
import { repositoryContext } from "./stage-git.js";
import {
  applyDeterministicWrites,
  markPullRequestFeedbackInvestigationStarted,
} from "./stage-writes.js";
import {
  buildValidationRepairPrompt,
  validationRepairMaxTurnsFor,
  type ValidationCommandFailure,
} from "./validation.js";
import { stageDefinitions } from "../shared/stages.js";
import type {
  ContextPacket,
  GitVibeConfig,
  JsonObject,
  RunnerOptions,
  StageRunResult,
} from "../shared/types.js";

type RunnerStageDefinition = (typeof stageDefinitions)[RunnerOptions["stage"]];

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

  const branchState = await prepareBranchForStage({ client, context, logger, options });

  const schema = loadStageSchema(definition.schemaFile);
  const prompts = renderPrompts({
    context,
    cwd: options.cwd,
    outputSchema: schema,
    promptDir: definition.promptDir,
    repositoryContext: repositoryContext(options.cwd, branchState.branchState),
    roleDefinition: roleDefinitionFor(options),
    stageContract: stageContract(options.stage, context),
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
    logger.event("stage.done", {
      status: result.status,
    });
    return result;
  }
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

  logger.event("stage.done", {
    status: result.status,
  });
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

async function runStageResultForMode(options: {
  aiRunOptions: RunAiStageOptions;
  config: GitVibeConfig;
  context: ContextPacket;
  definition: RunnerStageDefinition;
  executionMode: RunnerOptions["executionMode"];
  logger: StageLogger;
  options: RunnerOptions;
}): Promise<StageRunResult> {
  if (options.executionMode === "finalizer") {
    return runMatrixFinalizerResult(options);
  }
  return runStageAiResult(options);
}

async function loadRunnerContext(options: {
  client: GitHubClient;
  definition: RunnerStageDefinition;
  logger: StageLogger;
  options: RunnerOptions;
}): Promise<ContextPacket> {
  options.logger.event("context.load.start", { target: options.definition.target });
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
        reserveFinalizationTurns: false,
      }),
      context,
      definition,
      logger,
      options,
    });
}

async function runStageAiResult({
  aiRunOptions,
  context,
  definition,
  logger,
  options,
}: {
  aiRunOptions: RunAiStageOptions;
  context: ContextPacket;
  definition: (typeof stageDefinitions)[RunnerOptions["stage"]];
  logger: StageLogger;
  options: RunnerOptions;
}): Promise<StageRunResult> {
  const buildResult = (content: string): Promise<StageRunResult> =>
    stageRunResult({
      content,
      context,
      definition,
      logger,
      options,
    });

  if (options.dryRun) return buildResult(dryRunContent(options.stage, context, logger));

  try {
    return await buildResult(
      await runAiStage({
        ...aiRunOptions,
        reserveFinalizationTurns: options.stage === "implement",
      }),
    );
  } catch (error) {
    if (options.stage !== "implement" || !isStructuredOutputFailure(error)) throw error;
    logger.event("output.finalize.failed", {
      error: summarizeError(error),
      recovery: "same_session_exhausted",
    });
    return stageRunResult({
      content: JSON.stringify(
        blockedImplementOutput({
          context,
          finalError: error,
          firstError: error,
          options,
        }),
      ),
      context,
      definition,
      logger,
      options,
    });
  }
}

async function runMatrixFinalizerResult({
  aiRunOptions,
  config,
  context,
  definition,
  logger,
  options,
}: {
  aiRunOptions: RunAiStageOptions;
  config: GitVibeConfig;
  context: ContextPacket;
  definition: (typeof stageDefinitions)[RunnerOptions["stage"]];
  logger: StageLogger;
  options: RunnerOptions;
}): Promise<StageRunResult> {
  const plan = stageExecutionPlan(config, options.stage, options.cwd);
  const results = loadMatrixStageResults(options.memberResultsDir, options.stage);
  const expected = plan.matrix.include.length;
  const failed = Math.max(0, expected - results.length);

  logger.event("matrix.finalize.start", {
    expected,
    failed,
    mode: plan.mode,
    successful: results.length,
  });
  if (results.length === 0) {
    return stageRunResult({
      content: JSON.stringify(zeroMatrixResultsOutput({ context, expected, options })),
      context,
      definition,
      logger,
      options,
    });
  }
  if (options.dryRun || plan.mode === "profile") {
    return stageRunResult({
      content: JSON.stringify(results[0]?.parsedOutput),
      context,
      definition,
      logger,
      options,
    });
  }

  const prompt = [
    aiRunOptions.prompt,
    synthesisPromptAddition({
      expected,
      failed,
      results,
      roleGroup: plan.roleGroup,
      stage: options.stage,
    }),
  ].join("\n\n");
  return stageRunResult({
    content: await runAiStage({
      ...aiRunOptions,
      profileName: plan.synthesizerProfile,
      prompt,
      system: [aiRunOptions.system, synthesizerSystemAddition()].join("\n\n"),
    }),
    context,
    definition,
    logger,
    options,
  });
}

function isStructuredOutputFailure(error: unknown): boolean {
  const message = summarizeError(error);
  return (
    message === "AI response did not call output_validator" ||
    message === "AI response did not contain a JSON object" ||
    /^AI output failed .+ validation:/.test(message)
  );
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
  const metadata =
    options.executionMode === "member"
      ? matrixResultMetadata({
          profileName: options.profileName,
          result,
          roleName: options.roleName,
        })
      : undefined;
  result.resultFile = writeStageResultFile({
    directory: contextDir,
    metadata,
    result,
    stage: options.stage,
  });
  writeStageResultSummary({
    metadata,
    result,
    stage: options.stage,
    summaryPath: process.env.GITHUB_STEP_SUMMARY,
  });
  logger.event("result.persisted", { file: `git-vibe-${options.stage}-result.json` });
  return result;
}

function zeroMatrixResultsOutput(options: {
  context: ContextPacket;
  expected: number;
  options: RunnerOptions;
}): JsonObject {
  const reason = `No ${options.options.stage} matrix member results were available for synthesis. Expected ${options.expected}.`;
  const question = {
    options: ["Rerun the stage after matrix member results are available."],
    question: reason,
  };
  const base = {
    assumptions: [],
    comment_body: reason,
    findings: [reason],
    next_state: "blocked",
    references: [options.context.artifact.url, options.options.workflowRunUrl].filter(
      (value): value is string => Boolean(value),
    ),
    stage: options.options.stage,
    status: "blocked",
    summary: reason,
  };
  if (options.options.stage === "investigate") {
    return { ...base, blocking_questions: [question], implementation_plan: [], questions: [] };
  }
  return base;
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

function blockedImplementOutput(options: {
  context: ContextPacket;
  finalError: unknown;
  firstError: unknown;
  options: RunnerOptions;
}): JsonObject {
  const initial = summarizeError(options.firstError);
  const final = summarizeError(options.finalError);
  const summary = "Implementation stopped because the stage did not return schema-valid JSON.";
  return {
    assumptions: [],
    branch: issueBranch(options.context),
    comment_body: [
      summary,
      "",
      `Initial structured output failure: ${initial}`,
      `Finalization failure: ${final}`,
      "",
      "GitVibe left the working tree uncommitted so the next run can inspect and recover safely.",
    ].join("\n"),
    findings: [`Initial structured output failure: ${initial}`, `Finalization failure: ${final}`],
    next_state: "blocked",
    references: [options.context.artifact.url, options.options.workflowRunUrl].filter(
      (value): value is string => Boolean(value),
    ),
    stage: "implement",
    status: "blocked",
    summary,
    tests: ["Not run after the implement stage failed to produce schema-valid JSON."],
  };
}
