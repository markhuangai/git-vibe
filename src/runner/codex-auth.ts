import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sodium from "libsodium-wrappers";
import { splitRepository } from "../shared/github.js";
import type { GitHubClient } from "../shared/github.js";
import type { StageLogger } from "./logging.js";
import {
  aiEnvBundleVariable,
  bundleKeyFromSource,
  bundleValueFromSource,
  cliProfileEnv,
  parseRequiredAiEnvBundle,
} from "./cli-adapter-utils.js";

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
  const env = cliProfileEnv(options.profile, profilePath);
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
  logger?: StageLogger;
}): Promise<void> {
  if (!options.auth) return;

  const refreshedAuthJson = readFileSync(options.auth.authPath, "utf8");
  const updatedBundle = updatedAiEnvBundle(options.auth, refreshedAuthJson);
  if (!updatedBundle) {
    options.logger?.event("codex.auth_json.writeback.skip", { reason: "unchanged" });
    return;
  }
  if (!options.github) {
    throw new Error(
      "GITVIBE_GITHUB_TOKEN with repository Secrets read/write permission is required to update GITVIBE_AI_ENV_JSON after Codex auth refresh.",
    );
  }

  await updateRepositorySecret({
    ...options.github,
    name: aiEnvBundleVariable,
    value: updatedBundle,
  });
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

async function updateRepositorySecret(options: {
  client: GitHubClient;
  name: string;
  repository: string;
  token: string;
  value: string;
}): Promise<void> {
  const { owner, repo } = splitRepository(options.repository);
  const publicKey = await options.client.request<{ key?: string; key_id?: string }>({
    method: "GET",
    path: `/repos/${owner}/${repo}/actions/secrets/public-key`,
    token: options.token,
  });
  if (!publicKey.key || !publicKey.key_id) {
    throw new Error(
      `GitHub repository ${options.repository} did not return an Actions public key.`,
    );
  }
  await options.client.request({
    body: {
      encrypted_value: await encryptedSecretValue(options.value, publicKey.key),
      key_id: publicKey.key_id,
    },
    method: "PUT",
    path: `/repos/${owner}/${repo}/actions/secrets/${encodeURIComponent(options.name)}`,
    token: options.token,
  });
}

async function encryptedSecretValue(value: string, publicKey: string): Promise<string> {
  await sodium.ready;
  const keyBytes = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  const encryptedBytes = sodium.crypto_box_seal(value, keyBytes);
  return sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);
}
