import type { ContextPacket, GitVibeConfig, JsonObject, RunnerOptions } from "../shared/types.js";
import { contentUnitsForContext, type ContentUnit } from "./content-units.js";

export type SafetySeverity = "none" | "low" | "medium" | "high";

export interface SafetyGateResult {
  allowed: boolean;
  blockedReason?: string;
  findings: string[];
  severity: SafetySeverity;
}

export interface SafetySource {
  label: string;
  text: string;
}

export function promptInjectionGateEnabled(config: GitVibeConfig): boolean {
  return config.safety?.prompt_injection_gate !== false;
}

export function removeApprovalOnSafetyBlock(config: GitVibeConfig): boolean {
  return config.safety?.remove_approval_on_block !== false;
}

export function safetyGateSources(options: {
  context: ContextPacket;
  contextUnits?: ContentUnit[];
  extraSources?: SafetySource[];
  includeContext: boolean;
  output?: JsonObject;
}): ContentUnit[] {
  return [
    ...(options.includeContext
      ? (options.contextUnits ?? contentUnitsForContext(options.context))
      : []),
    ...(options.output
      ? [
          safetySourceUnit(
            { label: "stage output", text: JSON.stringify(options.output) },
            "stage-output",
          ),
        ]
      : []),
    ...(options.extraSources || []).map((source, index) =>
      safetySourceUnit(source, `extra-source-${index}`),
    ),
  ].filter((source) => source.text.trim());
}

export function allowedSafetyGateResult(): SafetyGateResult {
  return { allowed: true, findings: [], severity: "none" };
}

export function blockedSafetyGateResult(options: {
  findings: string[];
  reason?: string;
  severity?: Exclude<SafetySeverity, "none">;
}): SafetyGateResult {
  return {
    allowed: false,
    blockedReason:
      options.reason ||
      "High-risk prompt-injection content was detected before GitVibe could safely continue.",
    findings: options.findings,
    severity: options.severity || "high",
  };
}

export function safetyBlockedOutput(options: {
  context: ContextPacket;
  gate: SafetyGateResult;
  runner: RunnerOptions;
}): JsonObject {
  const summary = "GitVibe paused this run for maintainer review.";
  const question = {
    options: [
      "Change the flagged content or safety configuration, or apply `git-vibe:accept-risk` to accept this prompt-injection input risk for one rerun.",
    ],
    question:
      options.gate.blockedReason ||
      "GitVibe detected high-risk prompt-injection content in untrusted input.",
  };
  const base = {
    assumptions: [],
    comment_body: safetyBlockedComment(options.gate),
    findings: options.gate.findings,
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

function safetySourceUnit(source: SafetySource, id: string): ContentUnit {
  return {
    id,
    kind: "safety-source",
    label: source.label,
    text: source.text,
  };
}

function safetyBlockedComment(gate: SafetyGateResult): string {
  return [
    gate.blockedReason ||
      "High-risk prompt-injection content was detected before GitVibe could safely continue.",
    "",
    "GitVibe treats issue bodies, comments, diffs, repository files, and future image/OCR text as untrusted data. A trusted maintainer must change the flagged content, adjust safety configuration, apply `git-vibe:accept-risk` for a one-run acceptance, or handle the case manually before automation continues.",
    "",
    "Detected risk:",
    ...gate.findings.map((finding) => `- ${finding}`),
  ].join("\n");
}
