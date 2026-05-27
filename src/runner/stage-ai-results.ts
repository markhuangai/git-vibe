import { runAiStage, type RunAiStageOptions } from "./ai.js";
import { promptInjectionBlockedResult } from "./safety-gate-runner.js";
import type { SafetySource } from "./safety-gate.js";
import { blockedImplementOutput, zeroMatrixResultsOutput } from "./stage-blocked-outputs.js";
import { dryRunContent } from "./stage-dry-run.js";
import { stageRunResult } from "./stage-results.js";
import {
  loadMatrixStageResults,
  roleGroupSynthesisMembers,
  stageExecutionPlan,
  synthesisPromptAddition,
  synthesizerSystemAddition,
} from "./role-groups.js";
import { buildValidationRepairPrompt, validationRepairMaxTurnsFor } from "./validation.js";
import type { ValidationCommandFailure } from "./validation.js";
import { summarizeError, type StageLogger } from "./logging.js";
import { stageDefinitions } from "../shared/stages.js";
import type {
  ContextPacket,
  GitVibeConfig,
  RunnerOptions,
  StageRunResult,
} from "../shared/types.js";

export async function runStageResultForMode(options: {
  aiRunOptions: RunAiStageOptions;
  config: GitVibeConfig;
  context: ContextPacket;
  definition: (typeof stageDefinitions)[RunnerOptions["stage"]];
  executionMode: RunnerOptions["executionMode"];
  logger: StageLogger;
  options: RunnerOptions;
}): Promise<StageRunResult> {
  if (options.executionMode === "finalizer") {
    return runMatrixFinalizerResult(options);
  }
  return runStageAiResult(options);
}

export function validationRepairRunner({
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
  ): Promise<StageRunResult> => {
    const buildResult = stageResultBuilder({ context, definition, logger, options });
    const blocked = await promptInjectionBlockedResult({
      buildResult,
      config,
      context,
      extraSources: validationFailureSafetySources(failure),
      logger,
      phase: "input",
      runner: options,
    });
    if (blocked) return blocked;

    return buildResult(
      await runAiStage({
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
    );
  };
}

export function promptSafetySources(prompts: { prompt: string; system: string }): SafetySource[] {
  return [
    { label: "rendered stage system prompt", text: prompts.system },
    { label: "rendered stage user prompt", text: prompts.prompt },
  ];
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
  const buildResult = stageResultBuilder({ context, definition, logger, options });
  if (options.dryRun) return buildResult(dryRunContent(options.stage, context, logger));

  try {
    return await buildResult(await runAiStage(aiRunOptions));
  } catch (error) {
    if (options.stage !== "implement" || !isStructuredOutputFailure(error)) throw error;
    logger.event("output.finalize.failed", {
      error: summarizeError(error),
      recovery: "same_session_exhausted",
    });
    return buildResult(
      JSON.stringify(
        blockedImplementOutput({
          context,
          finalError: error,
          firstError: error,
          options,
        }),
      ),
    );
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

  const members = roleGroupSynthesisMembers(options.cwd, plan);
  const buildResult = stageResultBuilder({ context, definition, logger, options });
  const blocked = await promptInjectionBlockedResult({
    buildResult,
    config,
    context,
    extraSources: matrixFinalizerSafetySources({ members, results }),
    logger,
    phase: "input",
    runner: options,
  });
  if (blocked) return blocked;

  const prompt = [
    aiRunOptions.prompt,
    synthesisPromptAddition({
      expected,
      failed,
      members,
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

function validationFailureSafetySources(failure: ValidationCommandFailure): SafetySource[] {
  return [
    { label: "validation repair command", text: failure.command },
    { label: "validation repair stdout", text: failure.stdout },
    { label: "validation repair stderr", text: failure.stderr },
  ];
}

function matrixFinalizerSafetySources(options: {
  members: ReturnType<typeof roleGroupSynthesisMembers>;
  results: ReturnType<typeof loadMatrixStageResults>;
}): SafetySource[] {
  return [
    ...options.members.map((member) => ({
      label: `role-group ${member.role || member.profile || member.index} definition`,
      text: member.roleDefinition,
    })),
    ...options.results.map((result, index) => ({
      label: `matrix member result ${index + 1}`,
      text: JSON.stringify({
        output: result.parsedOutput,
        role: result.role,
        status: result.status,
        summary: result.summary,
      }),
    })),
  ];
}

function stageResultBuilder(options: {
  context: ContextPacket;
  definition: (typeof stageDefinitions)[RunnerOptions["stage"]];
  logger: StageLogger;
  options: RunnerOptions;
}): (content: string) => Promise<StageRunResult> {
  return (content: string) =>
    stageRunResult({
      content,
      context: options.context,
      definition: options.definition,
      logger: options.logger,
      options: options.options,
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
