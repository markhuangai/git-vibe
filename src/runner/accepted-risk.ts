import { addDiscussionComment, removeDiscussionLabel } from "../shared/discussions.js";
import { GitHubClient, splitRepository } from "../shared/github.js";
import { gitVibeLabels } from "../shared/labels.js";
import { parseStageResultMarker, stageResultStatus } from "../shared/stage-result-markers.js";
import { workflowRunIdFromUrl } from "../shared/status-comments.js";
import {
  acceptedRiskArtifactContentSha,
  acceptedRiskMetadataBodySha,
  parseAcceptedRiskMetadata,
  type AcceptedRiskMetadata,
  type AcceptedRiskMetadataSource,
} from "../shared/accepted-risk.js";
import type {
  ContextPacket,
  RunnerOptions,
  StageHandoff,
  StageRunResult,
  TimelineItem,
} from "../shared/types.js";
import { acceptedRiskDeltaContentUnits, type ContentUnit } from "./content-units.js";
import type { StageLogger } from "./logging.js";

const trustedAutomationAuthors = new Set(["gitvibe-for-github[bot]"]);

interface AcceptedRiskMetadataCandidate {
  metadata: AcceptedRiskMetadata;
  order: number;
  source: AcceptedRiskMetadataSource;
}

interface AcceptedRiskAuditMarker {
  artifact?: string;
  number?: string;
  run?: string;
  "run-attempt"?: string;
  stage?: string;
}

type AcceptedRiskRuntimeSource = "run-audit" | "run-binding";

export function acceptedRiskFromContext(options: {
  context: ContextPacket;
  logger: StageLogger;
  runner: RunnerOptions;
}): RunnerOptions["acceptedRisk"] | undefined {
  if (options.runner.acceptedRisk) return options.runner.acceptedRisk;

  const candidate = acceptedRiskMetadataForRunner(options.context, options.runner);
  if (!candidate) return undefined;

  const source = acceptedRiskRuntimeSource(candidate.metadata, options.context, options.runner);
  const acceptedRisk = source
    ? acceptedRiskFromMetadata(candidate.metadata)
    : acceptedRiskWithoutRunBinding(candidate.metadata);
  if (
    !source &&
    !acceptedRiskApplies({
      context: options.context,
      logger: options.logger,
      runner: { ...options.runner, acceptedRisk },
    })
  ) {
    options.logger.event("accepted_risk.skip", {
      reason: "workflow-run-not-bound",
      run: workflowRunIdFromUrl(options.runner.workflowRunUrl) || "",
      stage: options.runner.stage,
    });
    return undefined;
  }

  options.logger.event("accepted_risk.context.detected", {
    cutoff: candidate.metadata.cutoff,
    source: source || "metadata-baseline",
    stage: options.runner.stage,
    stages: candidate.metadata.stages.join(","),
  });
  return acceptedRisk;
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
  if (accepted.run) {
    const currentRun = workflowRunIdFromUrl(options.runner.workflowRunUrl);
    if (!currentRun || currentRun !== accepted.run) {
      options.logger.event("accepted_risk.skip", {
        accepted_run: accepted.run,
        current_run: currentRun || "",
        reason: "workflow-run-changed",
      });
      return false;
    }
  }
  if (accepted.runAttempt && accepted.runAttempt !== options.runner.workflowRunAttempt) {
    options.logger.event("accepted_risk.skip", {
      accepted_attempt: accepted.runAttempt,
      current_attempt: options.runner.workflowRunAttempt || "",
      reason: "workflow-run-attempt-changed",
    });
    return false;
  }
  if (options.context.artifact.type !== "pull-request") return true;
  const currentSha = options.context.artifact.pullRequestHead?.sha || "";
  if (accepted.artifactContentSha) {
    if (!acceptedRiskArtifactContentAccepted(options.context, accepted)) {
      options.logger.event("accepted_risk.skip", {
        reason: "pull-request-artifact-content-changed",
      });
      return false;
    }
    if (accepted.artifactSha && !currentSha) {
      options.logger.event("accepted_risk.skip", {
        reason: "missing-current-pull-request-head-sha",
      });
      return false;
    }
    return true;
  }
  if (!accepted.artifactSha) {
    options.logger.event("accepted_risk.skip", { reason: "missing-accepted-artifact-sha" });
    return false;
  }
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
  ignoredAuthors: readonly string[] = [],
): ContentUnit[] {
  const cutoff = runner.acceptedRisk?.cutoff;
  if (!cutoff) return [];
  const accepted = acceptedRiskMetadataForContext(context, runner);
  return acceptedRiskDeltaContentUnits({
    acceptedArtifactSha: runner.acceptedRisk?.artifactSha,
    acceptedMetadata: accepted?.metadata,
    acceptedSource: accepted?.source,
    context,
    cutoff,
    ignoredAuthors,
  });
}

export function contextWithoutAcceptedRiskMetadataSource(
  context: ContextPacket,
  runner: RunnerOptions,
): ContextPacket {
  const accepted = acceptedRiskMetadataForContext(context, runner);
  if (!accepted) return context;

  const timeline = context.timeline.filter((_, order) => order !== accepted.order);
  const handoffs = context.handoffs?.filter(
    (handoff) => !acceptedRiskHandoffSourceMatches(handoff, accepted.source),
  );
  const handoffsChanged = Boolean(context.handoffs && handoffs?.length !== context.handoffs.length);
  if (timeline.length === context.timeline.length && !handoffsChanged) return context;
  return { ...context, handoffs, timeline };
}

export function acceptedRiskLabelPresent(context: ContextPacket): boolean {
  return (context.artifact.labels || []).includes(gitVibeLabels.acceptRisk.name);
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
  if (options.runner.acceptedRisk?.run) {
    options.logger.event("accepted_risk.audit.skip", { reason: "run-bound-metadata" });
  } else {
    const body = acceptedRiskAuditBody(options);
    if (options.context.artifact.type === "discussion") {
      await publishDiscussionAudit(options, body);
    } else {
      await publishIssueAudit(options, body);
    }
  }
  await removeAcceptedRiskLabel(options);
}

export async function publishAcceptedRiskAuditForLabeledContext(options: {
  acceptedRisk: boolean;
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  result: StageRunResult;
  runner: RunnerOptions;
}): Promise<void> {
  if (!options.acceptedRisk) return;
  if (!acceptedRiskLabelPresent(options.context)) return;
  await publishAcceptedRiskAudit(options);
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
  const attempt = options.runner.workflowRunAttempt;
  const attemptAttribute = attempt ? ` run-attempt=${attempt}` : "";
  const riskLine = options.result
    ? "The high-risk findings remain visible in the GitVibe blocked result above."
    : cutoff
      ? `GitVibe did not detect high-risk prompt-injection content in context created or edited after \`${cutoff}\`.`
      : "The security scan did not detect high-risk prompt-injection content in this run.";
  return [
    `<!-- git-vibe:risk-accepted stage=${options.runner.stage} artifact=${options.context.artifact.type} number=${options.context.artifact.number}${runAttribute}${attemptAttribute} -->`,
    "## GitVibe Risk Accepted",
    "",
    `${actorLabel(actor)} accepted prompt-injection input risk for matching \`${options.runner.stage}\` context.`,
    riskLine,
    `GitVibe removed \`${gitVibeLabels.acceptRisk.name}\`; future runs reuse this acceptance only while the accepted artifact context still matches, and new context is still scanned.`,
    options.runner.workflowRunUrl ? `Workflow run: ${options.runner.workflowRunUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function acceptedRiskMetadataForContext(
  context: ContextPacket,
  runner: RunnerOptions,
): AcceptedRiskMetadataCandidate | undefined {
  const accepted = runner.acceptedRisk;
  if (!accepted) return undefined;
  return acceptedRiskMetadataCandidates(context, runner)
    .filter((candidate) =>
      acceptedRiskMetadataMatches({ accepted, context, metadata: candidate.metadata, runner }),
    )
    .at(-1);
}

function acceptedRiskMetadataForRunner(
  context: ContextPacket,
  runner: RunnerOptions,
): AcceptedRiskMetadataCandidate | undefined {
  return acceptedRiskMetadataCandidates(context, runner).at(-1);
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
  if (!trustedGitVibeTimelineItem(item)) return undefined;
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
  return { metadata, order, source: acceptedRiskMetadataSource(item) };
}

function acceptedRiskMetadataSource(item: TimelineItem): AcceptedRiskMetadataSource {
  return {
    bodySha: acceptedRiskMetadataBodySha(item.body),
    databaseId: stringValue(item.databaseId),
    id: stringValue(item.id),
    kind: item.kind,
    sourceUrl: item.url || undefined,
  };
}

function acceptedRiskFromMetadata(
  metadata: AcceptedRiskMetadata,
): NonNullable<RunnerOptions["acceptedRisk"]> {
  return {
    actor: metadata.actor,
    artifactContentSha: metadata.artifactContentSha,
    artifactSha: metadata.artifactSha,
    cutoff: metadata.cutoff,
    run: metadata.run,
    runAttempt: metadata.runAttempt,
    stages: metadata.stages,
  };
}

function acceptedRiskWithoutRunBinding(
  metadata: AcceptedRiskMetadata,
): NonNullable<RunnerOptions["acceptedRisk"]> {
  return {
    actor: metadata.actor,
    artifactContentSha: metadata.artifactContentSha,
    artifactSha: metadata.artifactSha,
    cutoff: metadata.cutoff,
    stages: metadata.stages,
  };
}

function acceptedRiskHandoffSourceMatches(
  handoff: StageHandoff,
  acceptedSource: AcceptedRiskMetadataSource,
): boolean {
  const source = handoff.source;
  return Boolean(
    source?.bodySha === acceptedSource.bodySha &&
    stringValue(source.kind) === acceptedSource.kind &&
    stringValue(source.sourceUrl) === acceptedSource.sourceUrl &&
    acceptedRiskSourceIdMatches(source, acceptedSource),
  );
}

function acceptedRiskSourceIdMatches(
  source: StageHandoff["source"],
  acceptedSource: AcceptedRiskMetadataSource,
): boolean {
  const ids = new Set([stringValue(source?.id), stringValue(source?.databaseId)].filter(Boolean));
  return Boolean(
    (acceptedSource.id && ids.has(acceptedSource.id)) ||
    (acceptedSource.databaseId && ids.has(acceptedSource.databaseId)),
  );
}

function acceptedRiskRuntimeSource(
  metadata: AcceptedRiskMetadata,
  context: ContextPacket,
  runner: RunnerOptions,
): AcceptedRiskRuntimeSource | undefined {
  if (acceptedRiskMetadataBoundToCurrentRun(metadata, runner)) return "run-binding";
  if (metadata.run) return undefined;
  return acceptedRiskAuditForCurrentRun(context, runner) ? "run-audit" : undefined;
}

function acceptedRiskMetadataBoundToCurrentRun(
  metadata: AcceptedRiskMetadata,
  runner: RunnerOptions,
): boolean {
  const run = workflowRunIdFromUrl(runner.workflowRunUrl);
  if (!run || !metadata.run || metadata.run !== run) return false;
  return !metadata.runAttempt || metadata.runAttempt === runner.workflowRunAttempt;
}

function acceptedRiskAuditForCurrentRun(context: ContextPacket, runner: RunnerOptions): boolean {
  const run = workflowRunIdFromUrl(runner.workflowRunUrl);
  if (!run) return false;
  return context.timeline.some((item) => {
    if (!trustedGitVibeTimelineItem(item)) return false;
    const marker = parseAcceptedRiskAuditMarker(item.body);
    return (
      marker?.artifact === context.artifact.type &&
      marker.number === context.artifact.number &&
      marker.run === run &&
      auditMarkerAttemptMatches(marker, runner)
    );
  });
}

function auditMarkerAttemptMatches(
  marker: AcceptedRiskAuditMarker,
  runner: RunnerOptions,
): boolean {
  const attempt = stringValue(runner.workflowRunAttempt);
  return !attempt || marker["run-attempt"] === attempt;
}

function parseAcceptedRiskAuditMarker(
  body: string | null | undefined,
): AcceptedRiskAuditMarker | undefined {
  const match = String(body || "").match(/<!--\s*git-vibe:risk-accepted\s+([^>]*)-->/);
  if (!match) return undefined;
  return parseAttributes(match[1] || "");
}

function trustedGitVibeTimelineItem(item: TimelineItem): boolean {
  const association = String(item.authorAssociation || "").toUpperCase();
  if (["COLLABORATOR", "MEMBER", "OWNER"].includes(association)) return true;
  return trustedAutomationAuthors.has(String(item.author || "").toLowerCase());
}

function stringValue(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
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
    (!options.accepted.artifactContentSha ||
      options.metadata.artifactContentSha === options.accepted.artifactContentSha) &&
    (!options.accepted.run || options.metadata.run === options.accepted.run) &&
    (!options.accepted.runAttempt || options.metadata.runAttempt === options.accepted.runAttempt) &&
    options.metadata.stages.includes(options.runner.stage)
  );
}

function acceptedRiskArtifactContentAccepted(
  context: ContextPacket,
  accepted: NonNullable<RunnerOptions["acceptedRisk"]>,
): boolean {
  return acceptedRiskArtifactContentSha(context.artifact) === accepted.artifactContentSha;
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
