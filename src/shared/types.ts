export type Stage =
  | "investigate"
  | "summarize"
  | "validate"
  | "materialize"
  | "implement"
  | "review-matrix"
  | "create-pr"
  | "address-pr-feedback";

export type JsonObject = Record<string, unknown>;
export type SourceCommentKind =
  | "discussion-comment"
  | "issue-comment"
  | "pull-request-comment"
  | "pull-request-review"
  | "pull-request-review-comment";

export interface StageDefinition {
  promptDir: string;
  schemaFile: string;
  schemaId: string;
  target: "issue" | "discussion" | "pull-request";
  tools: string[];
}

export interface RunnerOptions {
  cwd: string;
  dryRun: boolean;
  executionMode?: "finalizer" | "member" | "standard";
  failOnNotReady?: boolean;
  handoffDir?: string;
  issueNumber: string;
  memberResultsDir?: string;
  maxTurns: number;
  prNumber: string;
  profileName?: string;
  repository: string;
  roleName?: string;
  sourceComment?: SourceComment;
  stage: Stage;
  stageTimeoutMinutes: number;
  token: string;
  validationRepairAttempts?: number;
  validationRepairMaxTurns?: number;
  workflowRunUrl?: string;
}

export interface GitVibeConfig {
  ai?: JsonObject;
  tests?: {
    commands?: string[];
  };
}

export interface TimelineItem {
  author: string;
  authorAssociation?: string;
  body: string;
  createdAt: string;
  databaseId?: number | string;
  id: string;
  kind: string;
  parentId?: string;
  reactions?: JsonObject;
  url: string;
}

export interface StageHandoff {
  commentBody?: string;
  parsedOutput: JsonObject;
  schemaId: string;
  stage: Stage;
  status: string;
  summary: string;
}

export interface SourceComment {
  body?: string;
  id?: string;
  kind: SourceCommentKind;
  nodeId?: string;
  url?: string;
}

export interface ContextPacket {
  artifact: {
    body: string;
    id?: string;
    number: string;
    title: string;
    type: "issue" | "discussion" | "pull-request";
    url: string;
    pullRequestHead?: {
      branch: string;
      repository: string;
    };
  };
  generatedAt: string;
  handoffs?: StageHandoff[];
  repository: string;
  source?: {
    comment?: SourceComment;
  };
  timeline: TimelineItem[];
}

export interface StageRunResult {
  commentBody: string;
  parsedOutput: JsonObject;
  resultFile?: string;
  schemaId: string;
  status: string;
  summary: string;
  validationErrors: string[];
}
