import type { ContextPacket, JsonObject, RunnerOptions } from "../shared/types.js";
import type { ContextPromptCoverage } from "./content-units.js";
import { summarizeError } from "./logging.js";
import { issueBranch } from "./review-fix.js";

export function zeroMatrixResultsOutput(options: {
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

export function blockedImplementOutput(options: {
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

export function contextCoverageBlockedOutput(options: {
  context: ContextPacket;
  coverage: ContextPromptCoverage;
  runner: RunnerOptions;
}): JsonObject {
  const pendingPreview = options.coverage.pendingChunkIds.slice(0, 20);
  const summary = "GitVibe blocked this run because context coverage is incomplete.";
  const finding = `Only ${options.coverage.includedChunkIds.length} of ${options.coverage.totalChunks} context chunks were included in the final stage prompt.`;
  const question = {
    options: ["Rerun after GitVibe can process every pending context chunk."],
    question:
      "GitVibe cannot safely return a state-changing final result until every context chunk has been processed.",
  };
  const base = {
    assumptions: [],
    comment_body: [
      summary,
      "",
      finding,
      "",
      "Pending chunk ids:",
      ...pendingPreview.map((chunkId) => `- ${chunkId}`),
      options.coverage.pendingChunkIds.length > pendingPreview.length
        ? `- ...and ${options.coverage.pendingChunkIds.length - pendingPreview.length} more`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    findings: [finding],
    next_state: "blocked",
    questions: [question],
    references: [options.context.artifact.url, options.runner.workflowRunUrl].filter(
      (value): value is string => Boolean(value),
    ),
    stage: options.runner.stage,
    status: "blocked",
    summary,
  };

  if (options.runner.stage === "investigate") {
    return { ...base, blocking_questions: [question], implementation_plan: [] };
  }
  if (options.runner.stage === "materialize") return { ...base, issues: [] };
  if (options.runner.stage === "implement") {
    return {
      ...base,
      branch: issueBranch(options.context),
      tests: ["Not run because GitVibe did not process every context chunk."],
    };
  }
  if (options.runner.stage === "create-pr") {
    return { ...base, branch: issueBranch(options.context), pr_body: "", pr_title: "" };
  }
  if (options.runner.stage === "review-matrix") {
    return { ...base, inline_comments: [], tests: [] };
  }
  if (options.runner.stage === "address-pr-feedback") {
    return {
      ...base,
      skipped_feedback: pendingPreview,
      tests: ["Not run because GitVibe did not process every context chunk."],
    };
  }
  return base;
}
