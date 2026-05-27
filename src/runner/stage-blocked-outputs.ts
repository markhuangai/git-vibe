import type { ContextPacket, JsonObject, RunnerOptions } from "../shared/types.js";
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
