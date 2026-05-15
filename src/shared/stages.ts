import type { Stage, StageDefinition } from "./types.js";

export const stageDefinitions: Record<Stage, StageDefinition> = {
  investigate: {
    promptDir: "investigate",
    schemaFile: "investigate.v1.schema.json",
    schemaId: "investigate.v1",
    target: "issue",
    tools: ["read", "grep", "glob", "diff", "web-fetch", "web-search"],
  },
  summarize: {
    promptDir: "summarize",
    schemaFile: "summarize.v1.schema.json",
    schemaId: "summarize.v1",
    target: "discussion",
    tools: ["read", "grep", "glob", "web-fetch", "web-search"],
  },
  validate: {
    promptDir: "validate",
    schemaFile: "validate.v1.schema.json",
    schemaId: "validate.v1",
    target: "issue",
    tools: ["read", "grep", "glob", "web-fetch", "web-search"],
  },
  decompose: {
    promptDir: "decompose",
    schemaFile: "decompose.v1.schema.json",
    schemaId: "decompose.v1",
    target: "discussion",
    tools: ["read", "grep", "glob"],
  },
  materialize: {
    promptDir: "materialize",
    schemaFile: "materialize.v1.schema.json",
    schemaId: "materialize.v1",
    target: "discussion",
    tools: ["read", "grep", "glob"],
  },
  implement: {
    promptDir: "implement",
    schemaFile: "implement.v1.schema.json",
    schemaId: "implement.v1",
    target: "issue",
    tools: ["read", "grep", "glob", "edit", "write", "multi-edit", "bash", "diff"],
  },
  "review-matrix": {
    promptDir: "review-matrix",
    schemaFile: "review-matrix.v1.schema.json",
    schemaId: "review-matrix.v1",
    target: "issue",
    tools: ["read", "grep", "glob", "diff"],
  },
  "create-pr": {
    promptDir: "create-pr",
    schemaFile: "create-pr.v1.schema.json",
    schemaId: "create-pr.v1",
    target: "issue",
    tools: ["read", "grep", "glob", "diff"],
  },
  "address-pr-feedback": {
    promptDir: "address-pr-feedback",
    schemaFile: "address-pr-feedback.v1.schema.json",
    schemaId: "address-pr-feedback.v1",
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
