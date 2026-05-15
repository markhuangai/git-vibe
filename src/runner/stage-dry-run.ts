import type { StageLogger } from "./logging.js";
import { issueBranch } from "./review-fix.js";
import { issueBranchForStage } from "./stage-branches.js";
import type { ContextPacket, JsonObject } from "../shared/types.js";

export function stageContract(stage: string, context: ContextPacket): string {
  const deterministicBranch = issueBranchForStage(stage, context);
  const branchRule = deterministicBranch
    ? ` GitVibe has already prepared branch ${deterministicBranch}; stay on that branch, use it exactly, and do not fetch, checkout, reset, merge, push, or invent a branch name.`
    : "";
  return `Stage ${stage} is running.${branchRule} Return only JSON matching the schema. Call output_validator with the exact final JSON before responding.`;
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

  if (stage === "create-pr") {
    return {
      ...base,
      branch: issueBranch(context),
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

  if (stage === "decompose") {
    return {
      ...base,
      story_units: [
        {
          acceptance_criteria: ["Dry-run acceptance criteria."],
          background: `Dry-run story unit for ${context.artifact.url}`,
          backpressure_commands: [],
          blocked_by: [],
          parallel_group: "default",
          requirements: ["Dry-run requirement."],
          review_guidelines: ["Verify the dry-run output shape."],
          title: `Dry-run story for ${context.artifact.title}`,
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

function dryRunNextState(stage: string): string {
  const nextStates: Record<string, string> = {
    "address-pr-feedback": "feedback-addressed",
    "create-pr": "pr-draft-ready",
    decompose: "ready-for-materialization",
    implement: "changes-ready-for-commit",
    investigate: "needs-info",
    materialize: "implementation-issue-ready",
    "review-matrix": "review-passed",
    validate: "ready-for-implementation",
  };
  return nextStates[stage] || "blocked";
}
