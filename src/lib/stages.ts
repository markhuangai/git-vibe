import type { Stage, StageDefinition } from "./types.js";

export const stageDefinitions: Record<Stage, StageDefinition> = {
  investigate: {
    access: "read-only",
    promptDir: "bug-investigation",
    schemaFile: "bug-investigation.v1.schema.json",
    schemaId: "bug-investigation.v1",
    target: "issue",
    tools: ["read", "grep", "glob", "web-fetch", "web-search"],
  },
  summarize: {
    access: "read-only",
    promptDir: "feature-refinement",
    schemaFile: "feature-refinement.v1.schema.json",
    schemaId: "feature-refinement.v1",
    target: "discussion",
    tools: ["read", "grep", "glob", "web-fetch", "web-search"],
  },
  validate: {
    access: "read-only",
    promptDir: "pre-implementation-validation",
    schemaFile: "pre-implementation-validation.v1.schema.json",
    schemaId: "pre-implementation-validation.v1",
    target: "issue",
    tools: ["read", "grep", "glob", "web-fetch", "web-search"],
  },
  materialize: {
    access: "publish-write",
    promptDir: "materialize",
    schemaFile: "materialize.v1.schema.json",
    schemaId: "materialize.v1",
    target: "discussion",
    tools: ["read", "grep", "glob"],
  },
  implement: {
    access: "branch-write",
    promptDir: "implementation",
    schemaFile: "implementation.v1.schema.json",
    schemaId: "implementation.v1",
    target: "issue",
    tools: ["read", "grep", "glob", "edit", "write", "multi-edit", "bash", "diff"],
  },
  "review-matrix": {
    access: "read-only",
    promptDir: "review-matrix",
    schemaFile: "review-matrix.v1.schema.json",
    schemaId: "review-matrix.v1",
    target: "issue",
    tools: ["read", "grep", "glob", "diff"],
  },
  "create-pr": {
    access: "publish-write",
    promptDir: "create-pr",
    schemaFile: "create-pr.v1.schema.json",
    schemaId: "create-pr.v1",
    target: "issue",
    tools: ["read", "grep", "glob", "diff"],
  },
  "address-pr-feedback": {
    access: "branch-write",
    promptDir: "pr-feedback-remediation",
    schemaFile: "pr-feedback-remediation.v1.schema.json",
    schemaId: "pr-feedback-remediation.v1",
    target: "pull-request",
    tools: ["read", "grep", "glob", "edit", "write", "multi-edit", "bash", "diff"],
  },
};

export function parseStage(value: string | undefined): Stage {
  if (value && value in stageDefinitions) {
    return value as Stage;
  }

  throw new Error(`Unknown GitVibe action stage: ${value || "<missing>"}`);
}
