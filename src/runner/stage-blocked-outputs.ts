import type { ContextPacket, JsonObject, RunnerOptions } from "../shared/types.js";

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

export function mcpBlockedOutput(options: {
  context: ContextPacket;
  reason: string;
  runner: RunnerOptions;
}): JsonObject {
  const summary = "GitVibe blocked this run because required MCP context was unavailable.";
  const question = {
    options: ["Fix the MCP configuration or mark the MCP server optional, then rerun the stage."],
    question: options.reason,
  };
  const base = {
    assumptions: [],
    comment_body: [summary, "", options.reason].join("\n"),
    findings: [options.reason],
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
  if (options.runner.stage === "review-matrix") {
    return { ...base, inline_comments: [], tests: [] };
  }
  return base;
}
