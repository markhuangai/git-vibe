import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitHubClient } from "../shared/github.js";
import { updateRepositorySecret } from "../shared/repository-secrets.js";
import type { StageLogger } from "./logging.js";
import {
  aiEnvBundleVariable,
  bundleKeyFromSource,
  bundleValueFromSource,
  isRecord,
  parseRequiredAiEnvBundle,
  sdkProfileEnv,
} from "./sdk-adapter-utils.js";

export interface PreparedCodexAuth {
  authPath: string;
  bundleKey: string;
  profileName: string;
}

export interface PreparedCodexEnv {
  auth?: PreparedCodexAuth;
  env: NodeJS.ProcessEnv;
}

export interface CodexAuthWritebackGitHub {
  authWriteback?: (value: string) => Promise<void>;
  client: GitHubClient;
  repository: string;
  token: string;
}

export function prepareCodexEnv(options: {
  contextDir: string;
  profile: Record<string, unknown>;
  profileName: string;
}): PreparedCodexEnv {
  const profilePath = `ai.profiles.${options.profileName}`;
  const env = sdkProfileEnv(options.profile, profilePath);
  const auth = prepareCodexAuth({
    contextDir: options.contextDir,
    env,
    profile: options.profile,
    profileName: options.profileName,
    profilePath,
  });
  return { auth, env };
}

export async function writeBackCodexAuth(options: {
  auth: PreparedCodexAuth | undefined;
  github: CodexAuthWritebackGitHub | undefined;
  invalidAuth?: "skip" | "throw";
  logger?: StageLogger;
}): Promise<void> {
  if (!options.auth) return;

  const refreshedAuthJson = readFileSync(options.auth.authPath, "utf8");
  let validation: CodexAuthValidation;
  try {
    validation = validateCodexAuthJson(refreshedAuthJson);
  } catch (error) {
    options.logger?.event("codex.auth_json.validation.failed", {
      bundle_key: options.auth.bundleKey,
      reason: error instanceof Error ? error.message : String(error),
    });
    if (options.invalidAuth === "skip") {
      options.logger?.event("codex.auth_json.writeback.skip", {
        reason: "invalid-refreshed-auth",
      });
      return;
    }
    throw error;
  }
  options.logger?.event("codex.auth_json.validation.done", {
    auth_mode: validation.authMode,
    bundle_key: options.auth.bundleKey,
    has_access_token: validation.hasAccessToken,
    has_id_token: validation.hasIdToken,
    has_refresh_token: validation.hasRefreshToken,
    has_tokens: validation.hasTokens,
  });
  const updatedBundle = updatedAiEnvBundle(options.auth, refreshedAuthJson);
  if (!updatedBundle) {
    options.logger?.event("codex.auth_json.writeback.skip", { reason: "unchanged" });
    return;
  }
  if (!options.github) {
    throw new Error(
      "GitVibe GitHub App Secrets write permission is required to update GITVIBE_AI_ENV_JSON after Codex auth refresh.",
    );
  }

  if (options.github.authWriteback) {
    await options.github.authWriteback(updatedBundle);
  } else {
    await updateRepositorySecret({
      ...options.github,
      name: aiEnvBundleVariable,
      value: updatedBundle,
    });
  }
  process.env[aiEnvBundleVariable] = updatedBundle;
  options.logger?.event("codex.auth_json.writeback.done", {
    bundle_key: options.auth.bundleKey,
    secret: aiEnvBundleVariable,
  });
}

function prepareCodexAuth(options: {
  contextDir: string;
  env: NodeJS.ProcessEnv;
  profile: Record<string, unknown>;
  profileName: string;
  profilePath: string;
}): PreparedCodexAuth | undefined {
  const sourcePath = `${options.profilePath}.auth_json`;
  const bundleKey = bundleKeyFromSource(options.profile.auth_json, sourcePath);
  if (!bundleKey) return undefined;

  const authJson = bundleValueFromSource(options.profile.auth_json, sourcePath);
  if (!authJson) throw new Error(`${sourcePath}.from_bundle resolved to an empty value.`);
  const codexHome = options.env.CODEX_HOME || join(options.contextDir, "codex-home");
  options.env.CODEX_HOME = codexHome;
  mkdirSync(codexHome, { recursive: true });
  const authPath = join(codexHome, "auth.json");
  if (!existsSync(authPath)) writeFileSync(authPath, authJson);
  return { authPath, bundleKey, profileName: options.profileName };
}

function updatedAiEnvBundle(
  auth: PreparedCodexAuth,
  refreshedAuthJson: string,
): string | undefined {
  const bundle = parseRequiredAiEnvBundle(
    process.env,
    `ai.profiles.${auth.profileName}.auth_json write-back`,
  );
  if (bundle[auth.bundleKey] === refreshedAuthJson) return undefined;
  return JSON.stringify({ ...bundle, [auth.bundleKey]: refreshedAuthJson });
}

interface CodexAuthValidation {
  authMode: string;
  hasAccessToken: boolean;
  hasIdToken: boolean;
  hasRefreshToken: boolean;
  hasTokens: boolean;
}

function validateCodexAuthJson(authJson: string): CodexAuthValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authJson) as unknown;
  } catch (error) {
    throw new Error(`Codex auth.json must be valid JSON before write-back: ${String(error)}.`);
  }
  if (!isRecord(parsed)) throw new Error("Codex auth.json must be a JSON object.");

  const authMode = requiredString(parsed.auth_mode, "auth_mode");
  const tokens = parsed.tokens;
  if (tokens !== undefined && !isRecord(tokens)) {
    throw new Error("Codex auth.json tokens must be a JSON object when present.");
  }

  const tokenObject = isRecord(tokens) ? tokens : undefined;
  const idToken = optionalString(tokenObject?.id_token, "tokens.id_token");
  const accessToken = optionalString(tokenObject?.access_token, "tokens.access_token");
  const refreshToken = optionalString(tokenObject?.refresh_token, "tokens.refresh_token");

  if (idToken !== undefined && !jwtShaped(idToken)) {
    throw new Error("Codex auth.json tokens.id_token must be JWT-shaped.");
  }

  if (authMode === "chatgpt") {
    if (!tokenObject) throw new Error("Codex auth.json tokens are required for chatgpt auth.");
    if (!idToken) throw new Error("Codex auth.json tokens.id_token is required for chatgpt auth.");
    if (!refreshToken) {
      throw new Error("Codex auth.json tokens.refresh_token is required for chatgpt auth.");
    }
  }

  return {
    authMode,
    hasAccessToken: accessToken !== undefined,
    hasIdToken: idToken !== undefined,
    hasRefreshToken: refreshToken !== undefined,
    hasTokens: tokenObject !== undefined,
  };
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`Codex auth.json ${path} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Codex auth.json ${path} must be non-empty.`);
  return trimmed;
}

function requiredString(value: unknown, path: string): string {
  const result = optionalString(value, path);
  if (result === undefined) throw new Error(`Codex auth.json ${path} is required.`);
  return result;
}

function jwtShaped(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && parts.every((part) => base64UrlJwtSegment(part));
}

function base64UrlJwtSegment(value: string): boolean {
  return /^[A-Za-z0-9_-]+={0,2}$/.test(value) && value.length % 4 !== 1;
}
