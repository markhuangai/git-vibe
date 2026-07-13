import { mkdirSync } from "node:fs";
import type { CodexOptions } from "@openai/codex-sdk";
import { bundleValueFromSource, sdkProfileEnv, stringValue } from "./sdk-adapter-utils.js";

export interface PreparedCodexEnv {
  apiKey: string;
  baseUrl: string;
  env: NodeJS.ProcessEnv;
}

export function prepareCodexEnv(options: {
  codexHome: string;
  profile: Record<string, unknown>;
  profileName: string;
}): PreparedCodexEnv {
  const profilePath = `ai.profiles.${options.profileName}`;
  const env = sdkProfileEnv(options.profile, profilePath);
  const baseUrl = requiredBundleField(options.profile.base_url, `${profilePath}.base_url`);
  const apiKey = requiredBundleField(options.profile.api_key, `${profilePath}.api_key`);

  validateHttpBaseUrl(baseUrl, `${profilePath}.base_url`);
  mkdirSync(options.codexHome, { mode: 0o700, recursive: true });
  env.CODEX_HOME = options.codexHome;

  return { apiKey, baseUrl, env };
}

export function codexAuthOptions(env: PreparedCodexEnv): Pick<CodexOptions, "apiKey" | "baseUrl"> {
  return {
    apiKey: env.apiKey,
    baseUrl: env.baseUrl,
  };
}

function requiredBundleField(source: unknown, sourcePath: string): string {
  const value = bundleValueFromSource(source, sourcePath);
  if (value === undefined) {
    throw new Error(`${sourcePath} is required for codex-sdk profiles.`);
  }
  const trimmed = stringValue(value);
  if (!trimmed) throw new Error(`${sourcePath}.from_bundle resolved to an empty value.`);
  return trimmed.trim();
}

function validateHttpBaseUrl(value: string, sourcePath: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${sourcePath}.from_bundle must resolve to an absolute HTTP(S) URL.`);
  }

  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(`${sourcePath}.from_bundle must resolve to an absolute HTTP(S) URL.`);
  }
}
