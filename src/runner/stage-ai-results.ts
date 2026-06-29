import { runAiStage, type RunAiStageOptions } from "./ai.js";
import { zeroMatrixResultsOutput } from "./stage-blocked-outputs.js";
import { dryRunContent } from "./stage-dry-run.js";
import { stageRunResult } from "./stage-results.js";
import { promptInjectionBlockedResult } from "./safety-gate-runner.js";
import {
  loadMatrixStageResults,
  roleGroupSynthesisMembers,
  stageExecutionPlan,
  synthesisPromptAddition,
  synthesizerSystemAddition,
} from "./role-groups.js";
import type { StageLogger } from "./logging.js";
import { stageDefinitions } from "../shared/stages.js";
import type {
  ContextPacket,
  GitVibeConfig,
  JsonObject,
  RunnerOptions,
  StageRunResult,
} from "../shared/types.js";

export async function runStageResultForMode(options: {
  acceptedRisk: boolean;
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

  return buildResult(await runAiStage(aiRunOptions));
}

async function runMatrixFinalizerResult({
  acceptedRisk,
  aiRunOptions,
  config,
  context,
  definition,
  logger,
  options,
}: {
  acceptedRisk: boolean;
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
  const finalizerSafetySources = matrixFinalizerSafetySources({ results });
  const blocked = await promptInjectionBlockedResult({
    buildResult,
    config,
    context,
    extraSources: finalizerSafetySources,
    github: aiRunOptions.github,
    includeContext: !acceptedRisk,
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

function matrixFinalizerSafetySources(options: {
  results: ReturnType<typeof loadMatrixStageResults>;
}) {
  return options.results.map((result, index) => ({
    label: `matrix member result ${index + 1}`,
    text: JSON.stringify({
      output: sanitizedMatrixMemberSafetyValue(result.parsedOutput),
      role: result.role,
      status: result.status,
      summary: sanitizedGitVibeSafetyBoilerplate(result.summary),
    }),
  }));
}

function sanitizedMatrixMemberSafetyValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizedGitVibeSafetyBoilerplate(value);
  if (Array.isArray(value)) return value.map(sanitizedMatrixMemberSafetyValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonObject).map(([key, item]) => [
      key,
      sanitizedMatrixMemberSafetyValue(item),
    ]),
  );
}

function sanitizedGitVibeSafetyBoilerplate(value: string): string {
  return gitVibeSafetyBoilerplatePatterns
    .reduce((text, pattern) => text.replace(pattern, ""), value)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const gitVibeSafetyBoilerplatePatterns = [
  /\n*<!--\s*git-vibe:accepted-risk-metadata\s+[^>]*-->[\s\S]*?<!--\s*git-vibe:accepted-risk-end\s*-->\n*/g,
  /<!--\s*git-vibe:(?:stage-result|risk-accepted)\s+[^>]*-->/g,
  /^## GitVibe Risk Accepted\s*$/gm,
  /^### Accepted Risk\s*$/gm,
  /^Accepted at: .*$/gm,
  /^Accepted workflow run: .*$/gm,
  /^Accepted workflow attempt: .*$/gm,
  /^Accepted stages: .*$/gm,
  /^Artifact title\/body SHA: .*$/gm,
  /^Pull request head SHA: .*$/gm,
  /GitVibe paused this run for maintainer review\./g,
  /GitVibe replaced the previous blocked result details to keep this thread readable\./g,
  /GitVibe removed `git-vibe:accept-risk`; future runs reuse this acceptance only while the accepted artifact context still matches, and new context is still scanned\./g,
  /(?:`[^`]+`|@[\w-]+) accepted (?:this )?prompt-injection input risk for matching (?:`[\w-]+` )?context\./g,
  /(?:`[^`]+`|@[\w-]+) accepted (?:this )?prompt-injection input risk for one `?[\w-]+`? (?:run|rerun)\./g,
  /Change the flagged content or safety configuration, or apply `git-vibe:accept-risk` to accept this prompt-injection input risk for matching context\./g,
  /GitVibe treats issue bodies, comments, diffs, repository files, and future image\/OCR text as untrusted data\. A trusted maintainer must change the flagged content, adjust safety configuration, apply `git-vibe:accept-risk` for matching context, or handle the case manually before automation continues\./g,
];

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
