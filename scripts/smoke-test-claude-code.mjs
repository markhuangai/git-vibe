#!/usr/bin/env node

import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

/**
 * @typedef {Record<string, string | undefined>} Env
 * @typedef {{ error(message: string): void, log(message: string): void }} Logger
 * @typedef {{ effort?: import("@anthropic-ai/claude-agent-sdk").EffortLevel, env: NodeJS.ProcessEnv, model: string, profileName: string, secrets: string[] }} ClaudeSmokeConfig
 * @typedef {{ ok: boolean, source: "claude-code" }} ClaudeSmokeOutput
 * @typedef {{ query: typeof query }} ClaudeSmokeDependencies
 */

const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "source"],
  properties: {
    ok: { type: "boolean" },
    source: { enum: ["claude-code"] },
  },
};

/** @type {ClaudeSmokeDependencies} */
const defaultDependencies = { query };

if (isDirectRun(import.meta.url, process.argv[1])) {
  main().then((code) => {
    process.exitCode = code;
  });
}

/**
 * @param {{ cwd?: string, dependencies?: ClaudeSmokeDependencies, env?: Env, logger?: Logger }} [options]
 * @returns {Promise<number>}
 */
export async function main({
  cwd = process.cwd(),
  dependencies = defaultDependencies,
  env = process.env,
  logger = console,
} = {}) {
  try {
    const report = await runClaudeCodeSmokeTest({ cwd, dependencies, env });
    logger.log(
      `[git-vibe] claude-code-sdk smoke passed with profile=${report.profileName} model=${report.model}`,
    );
    return 0;
  } catch (error) {
    logger.error(`[git-vibe] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/**
 * @param {{ cwd: string, dependencies?: ClaudeSmokeDependencies, env: Env }} options
 * @returns {Promise<Pick<ClaudeSmokeConfig, "model" | "profileName">>}
 */
export async function runClaudeCodeSmokeTest({ cwd, dependencies = defaultDependencies, env }) {
  const config = readClaudeSmokeConfig({ cwd, env });
  let output;
  for await (const message of dependencies.query({
    options: {
      allowDangerouslySkipPermissions: true,
      cwd,
      effort: config.effort,
      env: config.env,
      maxTurns: 3,
      model: config.model,
      outputFormat: {
        schema: outputSchema,
        type: "json_schema",
      },
      permissionMode: "bypassPermissions",
      persistSession: false,
      settingSources: [],
      systemPrompt: "You are running a GitVibe smoke test. Do not modify files.",
    },
    prompt:
      'Return exactly this JSON object: {"ok": true, "source": "claude-code"}. Do not modify files.',
  })) {
    if (message.type !== "result") continue;
    if (message.subtype !== "success") {
      throw new Error(
        `Claude Code SDK smoke failed: ${redact(message.errors.join("; "), config.secrets)}`,
      );
    }
    output = claudeOutput(message.structured_output ?? message.result, config.secrets);
  }

  if (!output) throw new Error("Claude Code SDK smoke did not return a result message.");
  if (output.ok !== true || output.source !== "claude-code") {
    throw new Error(
      `unexpected Claude Code SDK smoke response: ${redact(JSON.stringify(output), config.secrets)}`,
    );
  }

  return { model: config.model, profileName: config.profileName };
}

/**
 * @param {{ cwd: string, env: Env }} options
 * @returns {ClaudeSmokeConfig}
 */
export function readClaudeSmokeConfig({ cwd, env }) {
  const config = readGitVibeConfig(cwd);
  const { profile, profileName } = claudeProfile(config, env.GITVIBE_AI_SMOKE_CLAUDE_PROFILE);
  const bundle = aiEnvBundle(env);
  const { childEnv, secrets } = profileEnv(profile, bundle, env, `ai.profiles.${profileName}`);
  const model = stringValue(profile.model);
  const reasoning = recordValueOrEmpty(profile.reasoning);
  if (!model) throw new Error(`AI profile ${profileName} model must be configured.`);

  return {
    effort: claudeEffort(stringValue(reasoning.effort)),
    env: childEnv,
    model,
    profileName,
    secrets,
  };
}

/**
 * @param {string | undefined} effort
 * @returns {ClaudeSmokeConfig["effort"]}
 */
function claudeEffort(effort) {
  if (!effort) return undefined;
  if (["low", "medium", "high", "xhigh", "max"].includes(effort)) {
    return /** @type {ClaudeSmokeConfig["effort"]} */ (effort);
  }
  throw new Error(`AI profile reasoning.effort is not supported by claude-code-sdk: ${effort}.`);
}

/**
 * @param {string} cwd
 * @returns {Record<string, unknown>}
 */
function readGitVibeConfig(cwd) {
  const path = resolve(cwd, ".github/git-vibe.yml");
  if (!existsSync(path)) {
    throw new Error(".github/git-vibe.yml is required for Claude Code SDK smoke.");
  }
  const parsed = parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(".github/git-vibe.yml must contain a YAML object.");
  }
  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * @param {Record<string, unknown>} config
 * @param {string | undefined} requestedProfile
 * @returns {{ profile: Record<string, unknown>, profileName: string }}
 */
function claudeProfile(config, requestedProfile) {
  const profiles = recordValue(recordValue(config.ai, "ai").profiles, "ai.profiles");
  const requested = stringValue(requestedProfile);
  if (requested) return namedClaudeProfile(profiles, requested);
  if (isClaudeProfile(profiles.claude_code)) {
    return {
      profile: /** @type {Record<string, unknown>} */ (profiles.claude_code),
      profileName: "claude_code",
    };
  }

  for (const [profileName, profile] of Object.entries(profiles)) {
    if (isClaudeProfile(profile)) return { profile, profileName };
  }

  throw new Error(".github/git-vibe.yml does not define an enabled claude-code-sdk profile.");
}

/**
 * @param {Record<string, unknown>} profiles
 * @param {string} profileName
 * @returns {{ profile: Record<string, unknown>, profileName: string }}
 */
function namedClaudeProfile(profiles, profileName) {
  const profile = profiles[profileName];
  if (!isClaudeProfile(profile)) {
    throw new Error(`AI profile ${profileName} must be an enabled claude-code-sdk profile.`);
  }
  return { profile, profileName };
}

/**
 * @param {unknown} profile
 * @returns {profile is Record<string, unknown>}
 */
function isClaudeProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return false;
  const record = /** @type {Record<string, unknown>} */ (profile);
  return Boolean(record.adapter === "claude-code-sdk" && record.enabled !== false);
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
function recordValue(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function recordValueOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {Record<string, unknown>} profile
 * @param {Record<string, string>} bundle
 * @param {Env} env
 * @param {string} profilePath
 * @returns {{ childEnv: NodeJS.ProcessEnv, secrets: string[] }}
 */
function profileEnv(profile, bundle, env, profilePath) {
  const childEnv = sanitizedChildEnv(env);
  childEnv.PATH = [join(env.HOME || homedir(), ".local", "bin"), env.PATH]
    .filter(Boolean)
    .join(delimiter);
  const secrets = Object.values(bundle);

  if (profile.env === undefined) return { childEnv, secrets };
  const profileEnvConfig = recordValue(profile.env, `${profilePath}.env`);
  for (const [target, source] of Object.entries(profileEnvConfig)) {
    if (!target.trim()) throw new Error(`${profilePath}.env keys must be non-empty strings.`);
    childEnv[target] = envValue(source, bundle, `${profilePath}.env.${target}`);
  }

  return { childEnv, secrets };
}

/**
 * @param {unknown} source
 * @param {Record<string, string>} bundle
 * @param {string} path
 * @returns {string}
 */
function envValue(source, bundle, path) {
  if (typeof source === "string") return source;
  const record = recordValue(source, path);
  const bundleKey = stringValue(record.from_bundle);
  if (!bundleKey) throw new Error(`${path}.from_bundle must be a non-empty string.`);
  if (!(bundleKey in bundle)) {
    throw new Error(`GITVIBE_AI_ENV_JSON.${bundleKey} is required by ${path}.from_bundle.`);
  }
  return bundle[bundleKey];
}

/**
 * @param {Env} env
 * @returns {Record<string, string>}
 */
function aiEnvBundle(env) {
  const raw = env.GITVIBE_AI_ENV_JSON;
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GITVIBE_AI_ENV_JSON must be a JSON object.");
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") throw new Error(`GITVIBE_AI_ENV_JSON.${key} must be a string.`);
  }
  return /** @type {Record<string, string>} */ (parsed);
}

/**
 * @param {Env} env
 * @returns {NodeJS.ProcessEnv}
 */
function sanitizedChildEnv(env) {
  const childEnv = { ...env };
  for (const name of Object.keys(childEnv)) {
    if (name === "GITVIBE_AI_ENV_JSON" || sensitiveEnvName(name)) delete childEnv[name];
  }
  return childEnv;
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function sensitiveEnvName(name) {
  return /(AUTH|AUTHORIZATION|CREDENTIALS?|KEY|PASSWORD|SECRET|TOKEN)/i.test(name);
}

/**
 * @param {unknown} value
 * @param {string[]} secrets
 * @returns {ClaudeSmokeOutput}
 */
function claudeOutput(value, secrets) {
  const response =
    value && typeof value === "object" && !Array.isArray(value)
      ? value
      : JSON.parse(extractJsonObject(String(value || ""), secrets));
  return /** @type {ClaudeSmokeOutput} */ (response);
}

/**
 * @param {string} text
 * @param {string[]} secrets
 * @returns {string}
 */
function extractJsonObject(text, secrets) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced) return fenced[1].trim();

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);

  throw new Error(`Claude Code SDK result did not contain JSON: ${excerpt(redact(text, secrets))}`);
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function stringValue(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * @param {string} text
 * @param {string[]} secrets
 * @returns {string}
 */
function redact(text, secrets) {
  return secrets.reduce(
    (result, secret) => (secret ? result.split(secret).join("***") : result),
    text,
  );
}

/**
 * @param {string} text
 * @returns {string}
 */
function excerpt(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

/**
 * @param {string} moduleUrl
 * @param {string | undefined} scriptPath
 * @returns {boolean}
 */
export function isDirectRun(moduleUrl, scriptPath) {
  return Boolean(scriptPath && moduleUrl === pathToFileURL(scriptPath).href);
}
