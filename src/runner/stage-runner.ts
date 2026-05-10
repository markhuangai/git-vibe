import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAiStage, type RunAiStageOptions } from "./ai.js";
import { loadConfig } from "./config.js";
import { buildDiscussionContext, buildIssueContext } from "./context.js";
import { GitHubClient } from "../shared/github.js";
import { withStageHandoffs, writeStageResultFile } from "./handoffs.js";
import type { StageLogger } from "./logging.js";
import { createStageLogger, summarizeError } from "./logging.js";
import { renderPrompts } from "./prompts.js";
import { issueBranch, type IssueBranchState, prepareIssueBranch } from "./review-fix.js";
import { renderStageResultComment } from "./result-comments.js";
import { loadStageSchema, validateOutput } from "./schemas.js";
import {
  applyStageLabelTransition,
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
import { gitOutput, repositoryContext } from "./stage-git.js";
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
    outputSchema: schema,
    promptDir: definition.promptDir,
    repositoryContext: repositoryContext(options.cwd, branchState.branchState),
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
    github: {
      client,
      repository: options.repository,
      token: options.token,
    },
    logger,
    maxTurns: options.maxTurns,
    prompt: prompts.prompt,
    schema,
    schemaId: definition.schemaId,
    stage: options.stage,
    stageDefinition: definition,
    system: prompts.system,
  };
  let result = await runStageAiResult({
    aiRunOptions,
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
    runnerBaseBranch: branchState.baseBranch,
    transientComments,
  });

  logger.event("stage.done", {
    status: result.status,
  });
  return result;
}

async function loadRunnerContext(options: {
  client: GitHubClient;
  definition: (typeof stageDefinitions)[RunnerOptions["stage"]];
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
  if (!options.options.dryRun && options.options.workflowRunUrl) {
    const comment = await publishStageStartComment({
      client: options.client,
      context: options.context,
      logger: options.logger,
      runner: options.options,
    });
    if (comment) transientComments.push(comment);
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
    return await buildResult(await runAiStage(aiRunOptions));
  } catch (error) {
    if (options.stage !== "implement" || !isStructuredOutputFailure(error)) throw error;
    return recoverImplementStructuredOutput({
      aiRunOptions,
      context,
      definition,
      firstError: error,
      logger,
      options,
    });
  }
}

function isStructuredOutputFailure(error: unknown): boolean {
  const message = summarizeError(error);
  return (
    message === "AI response did not contain a JSON object" ||
    /^AI output failed .+ validation:/.test(message)
  );
}

async function recoverImplementStructuredOutput({
  aiRunOptions,
  context,
  definition,
  firstError,
  logger,
  options,
}: {
  aiRunOptions: RunAiStageOptions;
  context: ContextPacket;
  definition: (typeof stageDefinitions)[RunnerOptions["stage"]];
  firstError: unknown;
  logger: StageLogger;
  options: RunnerOptions;
}): Promise<StageRunResult> {
  logger.event("output.finalize.start", { error: summarizeError(firstError) });
  try {
    const content = await runAiStage({
      ...aiRunOptions,
      maxTurns: structuredOutputFinalizationMaxTurns(options),
      prompt: buildStructuredOutputFinalizationPrompt({
        basePrompt: aiRunOptions.prompt,
        context,
        cwd: options.cwd,
        error: firstError,
      }),
      toolOverride: ["read", "grep", "glob", "bash-readonly", "diff"],
    });
    const result = await stageRunResult({
      content,
      context,
      definition,
      logger,
      options,
    });
    logger.event("output.finalize.done", { status: result.status });
    return result;
  } catch (error) {
    logger.event("output.finalize.failed", {
      error: summarizeError(error),
      previous_error: summarizeError(firstError),
    });
    return stageRunResult({
      content: JSON.stringify(
        blockedImplementOutput({
          context,
          finalError: error,
          firstError,
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

function buildStructuredOutputFinalizationPrompt(options: {
  basePrompt: string;
  context: ContextPacket;
  cwd: string;
  error: unknown;
}): string {
  const branch = issueBranch(options.context);
  return `${options.basePrompt}

<gitvibe_structured_output_finalization>
The previous implement attempt may have changed the working tree, but it did not return JSON matching the implement.v1 schema.

Failure: ${summarizeError(options.error)}

Current Git status:
\`\`\`
${gitOutput(options.cwd, ["status", "--short", "--branch"]) || "(clean)"}
\`\`\`

Diff stat against HEAD:
\`\`\`
${gitOutput(options.cwd, ["diff", "--stat", "HEAD"]) || "(no diff)"}
\`\`\`

Do not edit files, change branches, commit, push, fetch, merge, reset, or delete files. Inspect only the current working tree and return one JSON object matching implement.v1. Use status "completed" only when the intended implementation is present and ready for GitVibe validation and commit. Otherwise use status "blocked" and next_state "blocked".

The branch field, if included, must be ${branch}.
</gitvibe_structured_output_finalization>`;
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

function structuredOutputFinalizationMaxTurns(options: RunnerOptions): number {
  return Math.min(Math.max(options.maxTurns, 3), 10);
}
