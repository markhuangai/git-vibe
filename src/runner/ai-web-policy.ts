import { appendFileSync } from "node:fs";
import type { GitVibeConfig, Stage } from "../shared/types.js";
import type { StageLogger } from "./logging.js";

export const githubSearchTool = "github-search";
export const webFetchTool = "web-fetch";
export const webSearchTool = "web-search";

export interface AiWebPolicy {
  allowedDomains: string[];
}

interface FilterToolOptions {
  config: GitVibeConfig;
  explicit: boolean;
  logger?: StageLogger;
  stage: Stage;
  tools: string[];
}

export function webPolicyFor(config: GitVibeConfig): AiWebPolicy {
  const web = webConfig(config);
  if (web === undefined) {
    return { allowedDomains: [] };
  }
  if (Object.hasOwn(web, "allow_fetch")) {
    throw new Error(
      "ai.security.web.allow_fetch is not supported. Use ai.security.web.allowed_domains to allow website search and fetch.",
    );
  }

  const allowedDomains = domainPatterns(web.allowed_domains);
  return { allowedDomains };
}

export function filterToolsForWebPolicy(options: FilterToolOptions): string[] {
  const policy = webPolicyFor(options.config);
  const denied = options.tools.filter((tool) => !toolAllowedByWebPolicy(tool, policy));
  if (denied.length > 0 && options.explicit) {
    throw new Error(
      `ai.stages.${options.stage}.tools includes tools blocked by ai.security.web: ${denied.join(
        ", ",
      )}.`,
    );
  }

  if (denied.length > 0) {
    options.logger?.event("ai.web_policy.tools_disabled", {
      tools: denied.join(","),
      website_access: policy.allowedDomains.length > 0 ? "allowlist" : "disabled",
    });
  }

  return options.tools.filter((tool) => !denied.includes(tool));
}

export function hostAllowedByPolicy(host: string, policy: AiWebPolicy): boolean {
  const normalized = normalizeHost(host);
  return policy.allowedDomains.some((pattern) => hostMatchesDomainPattern(normalized, pattern));
}

export function urlAllowedByPolicy(url: string, policy: AiWebPolicy): boolean {
  try {
    const parsed = new URL(url);
    return hostAllowedByPolicy(parsed.hostname, policy);
  } catch {
    return false;
  }
}

export function domainPatternAllowed(host: string, pattern: string): boolean {
  return hostMatchesDomainPattern(normalizeHost(host), normalizeDomainPattern(pattern));
}

export function domainInputAllowedByPolicy(domain: string, policy: AiWebPolicy): boolean {
  try {
    const normalized = normalizeDomainPattern(domain);
    if (policy.allowedDomains.includes(normalized)) return true;
    return !normalized.startsWith("*.") && hostAllowedByPolicy(normalized, policy);
  } catch {
    return false;
  }
}

export function logCliWebPolicyNotice(options: {
  adapter: string;
  config: GitVibeConfig;
  logger?: StageLogger;
}): void {
  const policy = webPolicyFor(options.config);
  options.logger?.event("ai.web_policy.cli_notice", {
    adapter: options.adapter,
    allowed_domains: policy.allowedDomains.join(",") || "none",
    hard_network_boundary: "runner-required",
    native_web_tools: "disabled",
  });
  appendStepSummary(
    [
      "### GitVibe AI web policy",
      "",
      `- Adapter: \`${options.adapter}\``,
      `- Allowed website domains: \`${policy.allowedDomains.join(", ") || "none"}\``,
      "- Native CLI web-search/web-fetch tools are disabled where the CLI exposes controls.",
      "- Shell or process network egress is not a hard boundary unless the runner blocks it.",
      "",
    ].join("\n"),
  );
}

function toolAllowedByWebPolicy(tool: string, policy: AiWebPolicy): boolean {
  const websiteAllowed = policy.allowedDomains.length > 0;
  if (tool === githubSearchTool) return true;
  if (tool === webSearchTool) return websiteAllowed;
  if (tool === webFetchTool) return websiteAllowed;
  return true;
}

function webConfig(config: GitVibeConfig): Record<string, unknown> | undefined {
  const security = config.ai?.security;
  if (security === undefined) return undefined;
  if (!isRecord(security)) throw new Error("ai.security must be an object.");

  const web = security.web;
  if (web === undefined) return undefined;
  if (!isRecord(web)) throw new Error("ai.security.web must be an object.");
  return web;
}

function domainPatterns(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("ai.security.web.allowed_domains must be a string array.");
  }
  return value.map(normalizeDomainPattern);
}

function normalizeDomainPattern(pattern: string): string {
  const trimmed = pattern.trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed) throw new Error("ai.security.web.allowed_domains entries must be non-empty.");
  if (trimmed.includes("://") || trimmed.includes("/") || trimmed.includes(":")) {
    throw new Error(`Invalid ai.security.web.allowed_domains entry: ${pattern}.`);
  }

  if (trimmed.startsWith("*.")) {
    const suffix = trimmed.slice(2);
    validateHost(suffix, pattern);
    return `*.${suffix}`;
  }

  if (trimmed.includes("*")) {
    throw new Error(`Invalid ai.security.web.allowed_domains wildcard: ${pattern}.`);
  }

  validateHost(trimmed, pattern);
  return trimmed;
}

function hostMatchesDomainPattern(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === pattern;
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

function validateHost(host: string, original: string): void {
  const labels = host.split(".");
  if (
    labels.length < 2 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error(`Invalid ai.security.web.allowed_domains entry: ${original}.`);
  }
}

function appendStepSummary(content: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  appendFileSync(summaryPath, `${content}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
