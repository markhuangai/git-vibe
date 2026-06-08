import { addDiscussionComment, removeDiscussionLabel } from "../shared/discussions.js";
import { GitHubClient, splitRepository } from "../shared/github.js";
import { gitVibeLabels } from "../shared/labels.js";
import { parseStageResultMarker, stageResultStatus } from "../shared/stage-result-markers.js";
import { workflowRunIdFromUrl } from "../shared/status-comments.js";
import { parseAcceptedRiskMetadata, type AcceptedRiskMetadata } from "../shared/accepted-risk.js";
import type {
  ContextPacket,
  RunnerOptions,
  StageRunResult,
  TimelineItem,
} from "../shared/types.js";
import { acceptedRiskDeltaContentUnits, type ContentUnit } from "./content-units.js";
import type { StageLogger } from "./logging.js";

const trustedAutomationAuthors = new Set(["github-actions[bot]"]);

interface AcceptedRiskMetadataCandidate {
  metadata: AcceptedRiskMetadata;
  order: number;
}

interface AcceptedRiskAuditMarker {
  artifact?: string;
  number?: string;
  run?: string;
  stage?: string;
}

export function acceptedRiskFromContext(options: {
  context: ContextPacket;
  logger: StageLogger;
  runner: RunnerOptions;
}): RunnerOptions["acceptedRisk"] | undefined {
  if (options.runner.acceptedRisk) return options.runner.acceptedRisk;

  const metadata = acceptedRiskMetadataForRunner(options.context, options.runner);
  if (!metadata) return undefined;

  const source = acceptedRiskRuntimeSource(options.context, options.runner);
  if (!source) return undefined;

  options.logger.event("accepted_risk.context.detected", {
    cutoff: metadata.cutoff,
    source,
    stage: options.runner.stage,
    stages: metadata.stages.join(","),
  });
  return {
    actor: metadata.actor,
    artifactSha: metadata.artifactSha,
    cutoff: metadata.cutoff,
    stages: metadata.stages,
  };
}

export function runnerWithAcceptedRiskFromContext(options: {
  context: ContextPacket;
  logger: StageLogger;
  runner: RunnerOptions;
}): RunnerOptions {
  const acceptedRisk = acceptedRiskFromContext(options);
  return acceptedRisk === options.runner.acceptedRisk
    ? options.runner
    : { ...options.runner, acceptedRisk };
}

export function acceptedRiskApplies(options: {
  context: ContextPacket;
  logger: StageLogger;
  runner: RunnerOptions;
}): boolean {
  const accepted = options.runner.acceptedRisk;
  if (!accepted) return false;
  if (!accepted.stages.includes(options.runner.stage)) return false;
  if (!Number.isFinite(Date.parse(accepted.cutoff))) {
    options.logger.event("accepted_risk.skip", { reason: "invalid-accepted-risk-cutoff" });
    return false;
  }
  if (options.context.artifact.type !== "pull-request") return true;
  if (!accepted.artifactSha) {
    options.logger.event("accepted_risk.skip", { reason: "missing-accepted-artifact-sha" });
    return false;
  }

  const currentSha = options.context.artifact.pullRequestHead?.sha || "";
  if (currentSha && currentSha === accepted.artifactSha) return true;
  options.logger.event("accepted_risk.skip", {
    current_sha: currentSha,
    reason: "pull-request-head-changed",
  });
  return false;
}

export function acceptedRiskContextUnits(
  context: ContextPacket,
  runner: RunnerOptions,
): ContentUnit[] {
  const cutoff = runner.acceptedRisk?.cutoff;
  if (!cutoff) return [];
  const acceptedMetadata = acceptedRiskMetadataForContext(context, runner);
  return acceptedRiskDeltaContentUnits({
    acceptedMetadata,
    context,
    cutoff,
  });
}

export async function publishAcceptedRiskAudit(options: {
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  result?: StageRunResult;
  runner: RunnerOptions;
}): Promise<void> {
  if (options.runner.dryRun) {
    options.logger.event("accepted_risk.audit.skip", { reason: "dry-run" });
    return;
  }
  const body = acceptedRiskAuditBody(options);
  if (options.context.artifact.type === "discussion") {
    await publishDiscussionAudit(options, body);
  } else {
    await publishIssueAudit(options, body);
  }
  await removeAcceptedRiskLabel(options);
}

function acceptedRiskAuditBody(options: {
  context: ContextPacket;
  result?: StageRunResult;
  runner: RunnerOptions;
}): string {
  const actor = options.runner.acceptedRisk?.actor || "<unknown>";
  const cutoff = options.runner.acceptedRisk?.cutoff;
  const run = workflowRunIdFromUrl(options.runner.workflowRunUrl);
  const runAttribute = run ? ` run=${run}` : "";
  const riskLine = options.result
    ? "The high-risk findings remain visible in the GitVibe blocked result above."
    : cutoff
      ? `GitVibe did not detect high-risk prompt-injection content in context created or edited after \`${cutoff}\`.`
      : "The security scan did not detect high-risk prompt-injection content in this run.";
  return [
    `<!-- git-vibe:risk-accepted stage=${options.runner.stage} artifact=${options.context.artifact.type} number=${options.context.artifact.number}${runAttribute} -->`,
    "## GitVibe Risk Accepted",
    "",
    `${actorLabel(actor)} accepted prompt-injection input risk for one \`${options.runner.stage}\` run.`,
    riskLine,
    `GitVibe removed \`${gitVibeLabels.acceptRisk.name}\`; future runs require a fresh label.`,
    options.runner.workflowRunUrl ? `Workflow run: ${options.runner.workflowRunUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function acceptedRiskMetadataForContext(
  context: ContextPacket,
  runner: RunnerOptions,
): AcceptedRiskMetadata | undefined {
  const accepted = runner.acceptedRisk;
  if (!accepted) return undefined;
  return acceptedRiskMetadataCandidates(context, runner)
    .map((candidate) => candidate.metadata)
    .filter((metadata) => acceptedRiskMetadataMatches({ accepted, context, metadata, runner }))
    .at(-1);
}

function acceptedRiskMetadataForRunner(
  context: ContextPacket,
  runner: RunnerOptions,
): AcceptedRiskMetadata | undefined {
  return acceptedRiskMetadataCandidates(context, runner).at(-1)?.metadata;
}

function acceptedRiskMetadataCandidates(
  context: ContextPacket,
  runner: RunnerOptions,
): AcceptedRiskMetadataCandidate[] {
  return context.timeline
    .map((item, order) => acceptedRiskMetadataCandidate(item, order, context, runner))
    .filter((candidate): candidate is AcceptedRiskMetadataCandidate => Boolean(candidate));
}

function acceptedRiskMetadataCandidate(
  item: TimelineItem,
  order: number,
  context: ContextPacket,
  runner: RunnerOptions,
): AcceptedRiskMetadataCandidate | undefined {
  const marker = parseStageResultMarker(item.body);
  const metadata = parseAcceptedRiskMetadata(item.body);
  if (!marker || !metadata) return undefined;
  if (!trustedStageResultTimelineItem(item)) return undefined;
  if (stageResultStatus(item.body) !== "blocked") return undefined;
  if (marker.artifact !== context.artifact.type || marker.number !== context.artifact.number) {
    return undefined;
  }
  if (
    metadata.artifact !== context.artifact.type ||
    metadata.number !== context.artifact.number ||
    metadata.stage !== marker.stage ||
    !metadata.stages.includes(runner.stage) ||
    !Number.isFinite(Date.parse(metadata.cutoff))
  ) {
    return undefined;
  }
  return { metadata, order };
}

function acceptedRiskRuntimeSource(
  context: ContextPacket,
  runner: RunnerOptions,
): "label" | "run-audit" | undefined {
  if ((context.artifact.labels || []).includes(gitVibeLabels.acceptRisk.name)) return "label";
  return acceptedRiskAuditForCurrentRun(context, runner) ? "run-audit" : undefined;
}

function acceptedRiskAuditForCurrentRun(context: ContextPacket, runner: RunnerOptions): boolean {
  const run = workflowRunIdFromUrl(runner.workflowRunUrl);
  if (!run) return false;
  return context.timeline.some((item) => {
    const marker = parseAcceptedRiskAuditMarker(item.body);
    return (
      marker?.artifact === context.artifact.type &&
      marker.number === context.artifact.number &&
      marker.run === run
    );
  });
}

function parseAcceptedRiskAuditMarker(
  body: string | null | undefined,
): AcceptedRiskAuditMarker | undefined {
  const match = String(body || "").match(/<!--\s*git-vibe:risk-accepted\s+([^>]*)-->/);
  if (!match) return undefined;
  return parseAttributes(match[1] || "");
}

function trustedStageResultTimelineItem(item: TimelineItem): boolean {
  const association = String(item.authorAssociation || "").toUpperCase();
  if (["COLLABORATOR", "MEMBER", "OWNER"].includes(association)) return true;
  return trustedAutomationAuthors.has(String(item.author || "").toLowerCase());
}

function acceptedRiskMetadataMatches(options: {
  accepted: NonNullable<RunnerOptions["acceptedRisk"]>;
  context: ContextPacket;
  metadata: AcceptedRiskMetadata;
  runner: RunnerOptions;
}): boolean {
  return (
    options.metadata.artifact === options.context.artifact.type &&
    options.metadata.number === options.context.artifact.number &&
    options.metadata.cutoff === options.accepted.cutoff &&
    options.metadata.stages.includes(options.runner.stage)
  );
}

async function publishDiscussionAudit(
  options: {
    client: GitHubClient;
    context: ContextPacket;
    logger: StageLogger;
    runner: RunnerOptions;
  },
  body: string,
): Promise<void> {
  const discussionId = options.context.artifact.id;
  if (!discussionId) {
    options.logger.event("accepted_risk.audit.skip", { reason: "missing-discussion-id" });
    return;
  }
  await addDiscussionComment({
    body,
    client: options.client,
    discussionId,
    token: options.runner.token,
  });
}

async function publishIssueAudit(
  options: { client: GitHubClient; context: ContextPacket; runner: RunnerOptions },
  body: string,
): Promise<void> {
  const { owner, repo } = splitRepository(options.runner.repository);
  await options.client.request({
    body: { body },
    method: "POST",
    path: `/repos/${owner}/${repo}/issues/${options.context.artifact.number}/comments`,
    token: options.runner.token,
  });
}

async function removeAcceptedRiskLabel(options: {
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  runner: RunnerOptions;
}): Promise<void> {
  if (options.context.artifact.type === "discussion") {
    await removeDiscussionAcceptedRiskLabel(options);
    return;
  }
  await removeIssueAcceptedRiskLabel(options);
}

async function removeDiscussionAcceptedRiskLabel(options: {
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  runner: RunnerOptions;
}): Promise<void> {
  const discussionId = options.context.artifact.id;
  if (!discussionId) {
    options.logger.event("accepted_risk.label.remove.skip", { reason: "missing-discussion-id" });
    return;
  }
  try {
    await removeDiscussionLabel({
      client: options.client,
      discussionId,
      label: gitVibeLabels.acceptRisk.name,
      repository: options.runner.repository,
      token: options.runner.token,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) return;
    throw error;
  }
}

async function removeIssueAcceptedRiskLabel(options: {
  client: GitHubClient;
  context: ContextPacket;
  runner: RunnerOptions;
}): Promise<void> {
  const { owner, repo } = splitRepository(options.runner.repository);
  try {
    await options.client.request({
      method: "DELETE",
      path: `/repos/${owner}/${repo}/issues/${options.context.artifact.number}/labels/${encodeURIComponent(gitVibeLabels.acceptRisk.name)}`,
      token: options.runner.token,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) return;
    throw error;
  }
}

function actorLabel(actor: string): string {
  return /^[A-Za-z0-9-]+$/u.test(actor) ? `@${actor}` : `\`${actor.replaceAll("`", "'")}\``;
}

function parseAttributes(value: string): AcceptedRiskAuditMarker {
  const attributes: AcceptedRiskAuditMarker = {};
  for (const match of value.matchAll(/([a-z][a-z-]*)=([^\s>]+)/g)) {
    attributes[match[1] as keyof AcceptedRiskAuditMarker] = match[2] as string;
  }
  return attributes;
}
