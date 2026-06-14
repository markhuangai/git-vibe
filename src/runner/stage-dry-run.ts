import type { StageLogger } from "./logging.js";
import type { ContextPacket, JsonObject } from "../shared/types.js";

export function stageContract(stage: string, _context: ContextPacket): string {
  return `Stage ${stage} is running. Return only JSON matching the schema.`;
}

export function dryRunContent(stage: string, context: ContextPacket, logger: StageLogger): string {
  logger.event("ai.skip", { reason: "dry-run" });
  return JSON.stringify(dryRunOutput(stage, context));
}

function dryRunOutput(stage: string, context: ContextPacket): JsonObject {
  const base = {
    assumptions: [],
    comment_body: `GitVibe dry run for ${stage} on ${context.artifact.type} #${context.artifact.number}.`,
    findings: [],
    next_state: dryRunNextState(stage),
    references: [context.artifact.url].filter(Boolean),
    stage,
    status: "completed",
    summary: `Dry run completed for ${stage}.`,
  };

  if (stage === "materialize") {
    return {
      ...base,
      issues: [
        {
          acceptance_criteria: ["Dry-run acceptance criteria."],
          background: `Dry-run implementation issue for ${context.artifact.url}`,
          backpressure_commands: [],
          blocked_by: [],
          parallel_group: "default",
          requirements: ["Dry-run requirement."],
          review_guidelines: ["Verify the dry-run output shape."],
          title: `GitVibe dry run: ${context.artifact.title}`,
        },
      ],
    };
  }

  if (stage === "investigate" && context.artifact.type === "pull-request") {
    return {
      ...base,
      blocking_questions: [],
      feedback_items: [],
      implementation_plan: [],
      next_state: "no-fixes-needed",
      questions: [],
    };
  }

  if (stage === "investigate") {
    return {
      ...base,
      blocking_questions: [],
      implementation_plan: [],
      questions: [],
    };
  }

  return base;
}

function dryRunNextState(stage: string): string {
  const nextStates: Record<string, string> = {
    investigate: "needs-info",
    materialize: "implementation-issues-ready",
    "review-matrix": "review-passed",
    validate: "ready-for-implementation",
  };
  return nextStates[stage] || "blocked";
}
