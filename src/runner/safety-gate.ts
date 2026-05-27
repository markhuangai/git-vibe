import { gitVibeLabels } from "../shared/labels.js";
import type {
  ContextPacket,
  GitVibeConfig,
  JsonObject,
  RunnerOptions,
  Stage,
} from "../shared/types.js";
import { issueBranch } from "./review-fix.js";

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

interface PatternMatch {
  finding: string;
  severity: Exclude<SafetySeverity, "none">;
}

const writeStages = new Set<Stage>([
  "address-pr-feedback",
  "create-pr",
  "implement",
  "materialize",
]);

const highRiskPatterns: Array<{ finding: string; regex: RegExp }> = [
  {
    finding: "attempts to ignore higher-priority instructions",
    regex:
      /\b(?:disregard|forget|ignore|override)\b.{0,80}\b(?:above|all|developer|earlier|previous|prior|system)\b.{0,80}\b(?:instructions?|messages?|prompts?|rules?)\b/isu,
  },
  {
    finding: "attempts to activate an alternate model mode",
    regex: /\b(?:developer mode|do anything now|dan mode|jailbreak|roleplay as unrestricted)\b/isu,
  },
  {
    finding: "asks GitVibe to bypass validation, approval, or safety controls",
    regex:
      /\b(?:bypass|disable|skip)\b.{0,80}\b(?:approval|checks?|guardrails?|policy|safety|tests?|validation)\b/isu,
  },
  {
    finding: "asks for secrets, credentials, or hidden prompts",
    regex:
      /\b(?:exfiltrate|print|reveal|show|steal)\b.{0,80}\b(?:api[_ -]?key|credentials?|secrets?|system prompt|tokens?)\b/isu,
  },
  {
    finding: "asks the agent to decode and obey an encoded payload",
    regex: /\b(?:base64|decode|encoded payload)\b.{0,120}\b(?:execute|follow|obey|run)\b/isu,
  },
  {
    finding: "contains a destructive shell instruction",
    regex:
      /\b(?:rm\s+-rf|git\s+push\s+--force|curl\b.{0,80}\|\s*(?:bash|sh)|wget\b.{0,80}\|\s*(?:bash|sh))\b/isu,
  },
  {
    finding: "contains a multilingual instruction override",
    regex:
      /\b(?:ignora|ignorez|ignoriere)\b.{0,80}\b(?:anteriores|instrucciones|instructions|anweisungen)\b/isu,
  },
  {
    finding: "contains a CJK instruction override",
    regex:
      /(?:\u5ffd\u7565|\u7121\u8996).{0,80}(?:\u6307\u4ee4|\u6307\u793a|\u7cfb\u7d71|\u7cfb\u7edf)/su,
  },
  {
    finding: "contains a Cyrillic instruction override",
    regex:
      /(?:\u0438\u0433\u043d\u043e\u0440\u0438\u0440\u0443\u0439|\u0438\u0433\u043d\u043e\u0440\u0438\u0440\u043e\u0432\u0430\u0442\u044c).{0,80}\u0438\u043d\u0441\u0442\u0440\u0443\u043a/su,
  },
];

const mediumRiskPatterns: Array<{ finding: string; regex: RegExp }> = [
  {
    finding: "mentions hidden system or developer prompts",
    regex: /\b(?:developer|system)\s+prompt\b/isu,
  },
  {
    finding: "contains bidirectional or zero-width control characters",
    regex: /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u,
  },
  {
    finding: "contains an encoded or escaped payload",
    regex: /(?:\\x[0-9a-f]{2}){12,}|(?:0x[0-9a-f]{2}[\s,]*){12,}/isu,
  },
];

const base64CandidatePattern = /(?:[A-Za-z0-9+/]{24,}={0,2})(?:\s+[A-Za-z0-9+/]{24,}={0,2})*/g;
const urlPattern = /\bhttps?:\/\/[^\s<>)\]]+/giu;
const suspiciousLinkedFilePattern =
  /\.(?:7z|apk|app|bat|bash|cmd|deb|dmg|exe|jar|msi|pkg|ps1|rar|rpm|sh|tar|tgz|war|xz|zip)(?:[?#]|$)/iu;
const riskyLinkActionPattern =
  /\b(?:curl|download|execute|fetch|install|open|read|run|source|wget)\b/iu;

export function safetyGateForStage(options: {
  config: GitVibeConfig;
  context: ContextPacket;
  extraSources?: SafetySource[];
  output?: JsonObject;
  stage: Stage;
}): SafetyGateResult {
  if (!promptInjectionGateEnabled(options.config)) return allowedResult();

  const analysis = analyzeSources(
    sourcesFor(options.context, options.output, options.extraSources),
  );
  const shouldBlock =
    analysis.severity === "high" &&
    (options.output === undefined ||
      writeStageBlocked(options.config, options.stage) ||
      readOnlyOutputAdvancesPrivilegedState(options.stage, options.output));

  if (!shouldBlock) return { ...analysis, allowed: true };

  return {
    ...analysis,
    allowed: false,
    blockedReason:
      "High-risk prompt-injection content was detected before GitVibe could safely continue.",
  };
}

export function removeApprovalOnSafetyBlock(config: GitVibeConfig): boolean {
  return config.safety?.remove_approval_on_block !== false;
}

export function safetyFindingsForText(source: SafetySource): Omit<SafetyGateResult, "allowed"> {
  const matches = analyzeSource({
    ...source,
    text: boundedSourceText(source.text),
  });
  return {
    findings: unique(matches.map((match) => match.finding)),
    severity: highestSeverity(matches.map((match) => match.severity)),
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
      `Clarify the intended scope and reapply ${gitVibeLabels.approved.name} if automation should continue.`,
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
  if (options.runner.stage === "implement") {
    return {
      ...base,
      branch: issueBranch(options.context),
      tests: ["Not run because GitVibe paused before write-capable execution."],
    };
  }
  if (options.runner.stage === "create-pr") {
    return { ...base, branch: issueBranch(options.context), pr_body: "", pr_title: "" };
  }
  if (options.runner.stage === "review-matrix") {
    return { ...base, inline_comments: [], tests: [] };
  }
  if (options.runner.stage === "address-pr-feedback") {
    return {
      ...base,
      skipped_feedback: options.gate.findings,
      tests: ["Not run because GitVibe paused before write-capable execution."],
    };
  }
  return base;
}

function promptInjectionGateEnabled(config: GitVibeConfig): boolean {
  return config.safety?.prompt_injection_gate !== false;
}

function writeStageBlocked(config: GitVibeConfig, stage: Stage): boolean {
  return writeStages.has(stage) && config.safety?.block_write_stages_on_high_risk !== false;
}

function readOnlyOutputAdvancesPrivilegedState(
  stage: Stage,
  output: JsonObject | undefined,
): boolean {
  if (writeStages.has(stage)) return false;
  if (!output || normalizedState(output.status) !== "completed") return false;
  const nextState = normalizedState(output.next_state);
  const privilegedStates: Partial<Record<Stage, string[]>> = {
    "address-pr-feedback": ["feedback-addressed"],
    "create-pr": ["pr-draft-ready"],
    implement: ["changes-ready-for-commit"],
    investigate: ["fixes-required", "no-fixes-needed", "ready-for-implementation"],
    materialize: ["implementation-issue-ready", "implementation-issues-ready"],
    "review-matrix": ["changes-required", "review-passed"],
    validate: ["ready-for-implementation"],
  };
  return Boolean(privilegedStates[stage]?.includes(nextState));
}

function analyzeSources(sources: SafetySource[]): Omit<SafetyGateResult, "allowed"> {
  const matches = sources.flatMap((source) => analyzeSource(source));
  const findings = unique(matches.map((match) => match.finding));
  return {
    findings,
    severity: highestSeverity(matches.map((match) => match.severity)),
  };
}

function analyzeSource(source: SafetySource): PatternMatch[] {
  const text = source.text.trim();
  if (!text) return [];
  return [
    ...patternMatches(source.label, normalizedText(text), highRiskPatterns, "high"),
    ...patternMatches(source.label, text, mediumRiskPatterns, "medium"),
    ...base64Matches(source),
    ...linkMatches(source),
    ...mixedScriptMatches(source),
  ];
}

function patternMatches(
  label: string,
  text: string,
  patterns: Array<{ finding: string; regex: RegExp }>,
  severity: Exclude<SafetySeverity, "none">,
): PatternMatch[] {
  return patterns.flatMap((pattern) =>
    pattern.regex.test(text) ? [{ finding: `${label}: ${pattern.finding}`, severity }] : [],
  );
}

function base64Matches(source: SafetySource): PatternMatch[] {
  const matches: PatternMatch[] = [];
  for (const match of source.text.matchAll(base64CandidatePattern)) {
    const candidate = String(match[0] || "").replace(/\s+/g, "");
    if (!validBase64Candidate(candidate)) continue;

    const decoded = decodedBase64(candidate);
    if (!decoded) continue;

    const decodedHighRisk = patternMatches(
      `${source.label} decoded base64`,
      normalizedText(decoded),
      highRiskPatterns,
      "high",
    );
    if (decodedHighRisk.length) {
      matches.push({
        finding: `${source.label}: contains base64-decoded prompt-injection instructions`,
        severity: "high",
      });
      continue;
    }

    if (encodedPayloadInstruction(source.text)) {
      matches.push({
        finding: `${source.label}: asks the model to decode or obey an encoded payload`,
        severity: "high",
      });
    } else {
      matches.push({
        finding: `${source.label}: contains base64-like encoded content`,
        severity: "medium",
      });
    }
  }
  return matches;
}

function mixedScriptMatches(source: SafetySource): PatternMatch[] {
  const families = scriptFamilies(source.text);
  if (families.length < 2) return [];
  if (
    !/\b(?:approval|execute|instructions?|prompt|run|secrets?|system|tests?)\b/iu.test(source.text)
  ) {
    return [];
  }
  return [
    {
      finding: `${source.label}: mixes scripts around authority-sensitive terms`,
      severity: "medium",
    },
  ];
}

function linkMatches(source: SafetySource): PatternMatch[] {
  const matches: PatternMatch[] = [];
  for (const match of source.text.matchAll(urlPattern)) {
    const url = trimmedUrl(String(match[0] || ""));
    if (!url) continue;
    if (suspiciousLinkedFilePattern.test(url)) {
      matches.push({
        finding: `${source.label}: references a suspicious linked file type`,
        severity: nearbyRiskyLinkAction(source.text, match.index || 0) ? "high" : "medium",
      });
    }
    if (url.includes("github.com/user-attachments/assets/")) {
      matches.push({
        finding: `${source.label}: references a GitHub user attachment`,
        severity: "medium",
      });
    }
  }
  return matches;
}

function trimmedUrl(value: string): string {
  return value.replace(/[.,;:'"`]+$/u, "");
}

function nearbyRiskyLinkAction(text: string, index: number): boolean {
  const start = Math.max(0, index - 160);
  const end = Math.min(text.length, index + 240);
  return riskyLinkActionPattern.test(text.slice(start, end));
}

function sourcesFor(
  context: ContextPacket,
  output: JsonObject | undefined,
  extraSources: SafetySource[] = [],
): SafetySource[] {
  return [
    { label: "artifact title", text: context.artifact.title },
    { label: "artifact body", text: context.artifact.body },
    ...context.timeline.map((item) => ({
      label: `${item.kind} ${item.id || item.url || "timeline item"}`,
      text: item.body,
    })),
    ...(context.source?.comment?.body
      ? [{ label: "source command comment", text: context.source.comment.body }]
      : []),
    ...(context.handoffs || []).map((handoff) => ({
      label: `${handoff.stage} handoff`,
      text: [handoff.summary, handoff.commentBody, JSON.stringify(handoff.parsedOutput)].join("\n"),
    })),
    ...(context.pullRequestFiles || []).map((file) => ({
      label: `pull request file ${file.filename}`,
      text: pullRequestFileSafetyText(file),
    })),
    ...(output ? [{ label: "stage output", text: JSON.stringify(output) }] : []),
    ...extraSources,
  ].map((source) => ({ ...source, text: boundedSourceText(source.text) }));
}

function pullRequestFileSafetyText(
  file: NonNullable<ContextPacket["pullRequestFiles"]>[number],
): string {
  return [
    `filename: ${file.filename}`,
    `status: ${file.status}`,
    file.previousFilename ? `previous filename: ${file.previousFilename}` : "",
    file.additions === undefined ? "" : `additions: ${file.additions}`,
    file.deletions === undefined ? "" : `deletions: ${file.deletions}`,
    file.changes === undefined ? "" : `changes: ${file.changes}`,
    file.blobUrl ? `blob URL: ${file.blobUrl}` : "",
    file.rawUrl ? `raw URL: ${file.rawUrl}` : "",
    file.contentsUrl ? `contents URL: ${file.contentsUrl}` : "",
    file.patch ? `patch:\n${file.patch}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu, "");
}

function boundedSourceText(value: string): string {
  return value.length <= 20_000 ? value : `${value.slice(0, 10_000)}\n${value.slice(-10_000)}`;
}

function validBase64Candidate(value: string): boolean {
  return (
    value.length >= 40 &&
    value.length <= 12_000 &&
    value.length % 4 === 0 &&
    /[+/=0-9]/.test(value) &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

function decodedBase64(value: string): string | undefined {
  const decoded = Buffer.from(value, "base64").toString("utf8");
  if (!mostlyPrintable(decoded)) return undefined;
  return decoded;
}

function mostlyPrintable(value: string): boolean {
  if (!value.trim() || value.includes("\uFFFD")) return false;
  const printable = [...value].filter((char) => /[\p{L}\p{N}\p{P}\p{S}\p{Zs}\r\n\t]/u.test(char));
  return printable.length / [...value].length >= 0.85;
}

function encodedPayloadInstruction(value: string): boolean {
  return /\b(?:base64|decode|encoded payload)\b.{0,120}\b(?:execute|follow|obey|run)\b/isu.test(
    value,
  );
}

function scriptFamilies(value: string): string[] {
  const scripts: Array<[string, RegExp]> = [
    ["arabic", /\p{Script=Arabic}/u],
    ["cjk", /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u],
    ["cyrillic", /\p{Script=Cyrillic}/u],
    ["greek", /\p{Script=Greek}/u],
    ["hebrew", /\p{Script=Hebrew}/u],
    ["latin", /\p{Script=Latin}/u],
  ];
  return scripts.filter(([, regex]) => regex.test(value)).map(([name]) => name);
}

function safetyBlockedComment(gate: SafetyGateResult): string {
  return [
    gate.blockedReason ||
      "High-risk prompt-injection content was detected before GitVibe could safely continue.",
    "",
    "GitVibe treats issue bodies, comments, diffs, repository files, and future image/OCR text as untrusted data. A trusted maintainer must clarify the intended scope before automation continues.",
    "",
    "Detected risk:",
    ...gate.findings.map((finding) => `- ${finding}`),
  ].join("\n");
}

function normalizedState(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-")
    .replace(/\s+/g, "-");
}

function allowedResult(): SafetyGateResult {
  return { allowed: true, findings: [], severity: "none" };
}

function highestSeverity(values: Array<Exclude<SafetySeverity, "none">>): SafetySeverity {
  if (values.includes("high")) return "high";
  if (values.includes("medium")) return "medium";
  return "none";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
