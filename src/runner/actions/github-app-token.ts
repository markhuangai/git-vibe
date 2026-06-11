import { defaultActionsCodexAuthUrl, defaultActionsTokenUrl } from "../../shared/hosted-app.js";
import {
  isGitHubActionsRunnerPermissionProfile,
  type GitHubActionsRunnerPermissionProfile,
} from "../../shared/github-app-permissions.js";
import type { RunnerOptions, Stage } from "../../shared/types.js";

export interface GitHubAppTokenRuntime {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  permissionProfile?: GitHubActionsRunnerPermissionProfile;
}

interface OidcTokenResponse {
  value?: string;
}

interface ActionsTokenResponse {
  token?: string;
}

interface ActionsCodexAuthResponse {
  updated?: boolean;
}

export async function githubAppToken(runtime: GitHubAppTokenRuntime = {}): Promise<string> {
  const env = runtime.env || process.env;
  const existingToken = env.GITVIBE_GITHUB_APP_TOKEN?.trim();
  if (existingToken) return existingToken;

  const permissionProfile = requiredPermissionProfile(runtime.permissionProfile);
  const fetchImpl = runtime.fetch || fetch;
  const oidcToken = await requestActionsOidcToken(env, fetchImpl);
  return exchangeActionsOidcToken(env, fetchImpl, oidcToken, permissionProfile);
}

export async function githubAppCodexAuthWriteback(
  value: string,
  runtime: Pick<GitHubAppTokenRuntime, "env" | "fetch"> = {},
): Promise<void> {
  const env = runtime.env || process.env;
  const fetchImpl = runtime.fetch || fetch;
  const oidcToken = await requestActionsOidcToken(env, fetchImpl);
  const response = await fetchImpl(actionsCodexAuthUrl(env), {
    body: JSON.stringify({ oidcToken, value }),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    method: "POST",
  });
  const data = await responseJson<ActionsCodexAuthResponse>(response, "GitVibe actions Codex auth");
  if (data.updated !== true) {
    throw new Error("GitVibe actions Codex auth response was missing updated=true.");
  }
}

export function runnerPermissionProfileForStage(
  stage: Stage,
  executionMode: RunnerOptions["executionMode"] = "standard",
): GitHubActionsRunnerPermissionProfile {
  if (executionMode === "member") return "runner-read";
  if (stage === "review-matrix") return "runner-workflow-write";
  if (stage === "implement" || stage === "address-pr-feedback") return "runner-content-write";
  return "runner-status-write";
}

async function requestActionsOidcToken(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<string> {
  const requestUrl = requiredEnv(
    env,
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_URL is required. Add permissions: id-token: write to this job.",
  );
  const requestToken = requiredEnv(
    env,
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN is required. Add permissions: id-token: write to this job.",
  );
  const url = new URL(requestUrl);
  url.searchParams.set("audience", actionsOidcAudience(env));

  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${requestToken}` },
  });
  const data = await responseJson<OidcTokenResponse>(response, "GitHub Actions OIDC token");
  if (!data.value) throw new Error("GitHub Actions OIDC token response was missing value.");
  return data.value;
}

async function exchangeActionsOidcToken(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  oidcToken: string,
  permissionProfile: GitHubActionsRunnerPermissionProfile,
): Promise<string> {
  const response = await fetchImpl(actionsTokenUrl(env), {
    body: JSON.stringify({ oidcToken, permissionProfile }),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    method: "POST",
  });
  const data = await responseJson<ActionsTokenResponse>(response, "GitVibe actions token");
  if (!data.token) throw new Error("GitVibe actions token response was missing token.");
  return data.token;
}

function requiredPermissionProfile(
  value: GitHubActionsRunnerPermissionProfile | undefined,
): GitHubActionsRunnerPermissionProfile {
  if (value && isGitHubActionsRunnerPermissionProfile(value)) return value;
  if (value) throw new Error(`Unsupported GitHub App token permission profile: ${value}.`);
  throw new Error("GitHub App permission profile is required when requesting a hosted token.");
}

async function responseJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    throw new Error(`${label} request failed: ${response.status} ${JSON.stringify(data)}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${label} response must be a JSON object.`);
  }
  return data as T;
}

function actionsTokenUrl(env: NodeJS.ProcessEnv): string {
  return env.GITVIBE_ACTIONS_TOKEN_URL || defaultActionsTokenUrl;
}

function actionsCodexAuthUrl(env: NodeJS.ProcessEnv): string {
  return env.GITVIBE_ACTIONS_CODEX_AUTH_URL || defaultActionsCodexAuthUrl;
}

function actionsOidcAudience(env: NodeJS.ProcessEnv): string {
  return env.GITVIBE_ACTIONS_OIDC_AUDIENCE || actionsTokenUrl(env);
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string, message: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(message);
  return value;
}
