import type { Stage, StageDefinition } from "./types.js";

export const stageDefinitions: Record<Stage, StageDefinition> = {
  investigate: {
    promptDir: "investigate",
    schemaFile: "investigate.v1.schema.json",
    schemaId: "investigate.v1",
    target: "issue",
    tools: ["read", "grep", "glob", "diff", "github-search", "web-fetch", "web-search", "agent"],
  },
  validate: {
    promptDir: "validate",
    schemaFile: "validate.v1.schema.json",
    schemaId: "validate.v1",
    target: "issue",
    tools: ["read", "grep", "glob", "github-search", "web-fetch", "web-search", "agent"],
  },
  materialize: {
    promptDir: "materialize",
    schemaFile: "materialize.v2.schema.json",
    schemaId: "materialize.v2",
    target: "discussion",
    tools: ["read", "grep", "glob"],
  },
  "review-matrix": {
    promptDir: "review-matrix",
    schemaFile: "review-matrix.v1.schema.json",
    schemaId: "review-matrix.v1",
    target: "issue",
    tools: ["read", "grep", "glob", "diff", "agent"],
  },
};

export function parseStage(value: string | undefined): Stage {
  if (value && value in stageDefinitions) {
    return value as Stage;
  }

  throw new Error(`Unknown GitVibe action stage: ${value || "<missing>"}`);
}
