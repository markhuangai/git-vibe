export type Stage =
  | "investigate"
  | "summarize"
  | "validate"
  | "materialize"
  | "implement"
  | "review-matrix"
  | "create-pr"
  | "address-pr-feedback";

export type StageAccess = "read-only" | "branch-write" | "publish-write";
export type JsonObject = Record<string, unknown>;

export interface StageDefinition {
  access: StageAccess;
  promptDir: string;
  schemaFile: string;
  schemaId: string;
  target: "issue" | "discussion" | "pull-request";
  tools: string[];
}

export interface RunnerOptions {
  cwd: string;
  dryRun: boolean;
  issueNumber: string;
  maxTurns: number;
  prNumber: string;
  repository: string;
  stage: Stage;
  stageTimeoutMinutes: number;
  token: string;
}

export interface GitVibeConfig {
  ai?: JsonObject;
  branches?: {
    base?: string;
  };
  tests?: {
    commands?: string[];
  };
}

export interface TimelineItem {
  author: string;
  authorAssociation?: string;
  body: string;
  createdAt: string;
  id: string;
  kind: string;
  parentId?: string;
  reactions?: JsonObject;
  url: string;
}

export interface ContextPacket {
  artifact: {
    body: string;
    id?: string;
    number: string;
    title: string;
    type: "issue" | "discussion" | "pull-request";
    url: string;
  };
  generatedAt: string;
  repository: string;
  timeline: TimelineItem[];
}

export interface StageRunResult {
  commentBody: string;
  parsedOutput: JsonObject;
  schemaId: string;
  status: string;
  summary: string;
  validationErrors: string[];
}
