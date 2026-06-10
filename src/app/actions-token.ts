import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { splitRepository, type GitHubClient } from "../shared/github.js";
import {
  isGitHubActionsRunnerPermissionProfile,
  runnerPermissionProfileForGitHubActionsJob,
  type GitHubActionsRunnerPermissionProfile,
  type InstallationTokenProvider,
} from "./github-app-auth.js";

export interface ActionsTokenRequestBody {
  oidcToken?: string;
  oidc_token?: string;
  permissionProfile?: string;
  permission_profile?: string;
}

export interface ActionsTokenExchangeOptions {
  audience: string;
  body: string;
  client: GitHubClient;
  tokenProvider: InstallationTokenProvider;
  trustedWorkflowRefPattern?: RegExp;
  verifier: GitHubActionsOidcVerifier;
}

export interface ActionsTokenResponse {
  expires_in: number;
  token: string;
}

export interface GitHubActionsClaims {
  checkRunId: string;
  jobWorkflowRef: string;
  repository: string;
  repositoryId: string;
  repositoryOwner: string;
  sha: string;
  workflowRef: string;
}

export interface VerifiedGitHubActionsJob {
  checkRunName: string;
  claims: GitHubActionsClaims;
  owner: string;
  profile: GitHubActionsRunnerPermissionProfile;
  repo: string;
}

export interface GitHubActionsJobVerificationOptions {
  audience: string;
  client: GitHubClient;
  oidcToken: string;
  tokenProvider: InstallationTokenProvider;
  trustedWorkflowRefPattern?: RegExp;
  verifier: GitHubActionsOidcVerifier;
}

export interface GitHubActionsOidcVerifier {
  verify(oidcToken: string, audience: string): Promise<GitHubActionsClaims>;
}

export const defaultTrustedWorkflowRefPattern =
  /^markhuangai\/git-vibe\/\.github\/workflows\/[-\w]+\.yml@(?:v\d+(?:\.\d+){0,2}|refs\/tags\/v\d+(?:\.\d+){0,2}|refs\/heads\/(?:main|dev))$/;

const githubActionsIssuer = "https://token.actions.githubusercontent.com";
const githubActionsJwksUrl = "https://token.actions.githubusercontent.com/.well-known/jwks";

export class RemoteGitHubActionsOidcVerifier implements GitHubActionsOidcVerifier {
  private readonly jwks = createRemoteJWKSet(new URL(githubActionsJwksUrl));

  async verify(oidcToken: string, audience: string): Promise<GitHubActionsClaims> {
    const { payload } = await jwtVerify(oidcToken, this.jwks, {
      audience,
      issuer: githubActionsIssuer,
    });
    return claimsFromPayload(payload);
  }
}

export async function exchangeActionsToken(
  options: ActionsTokenExchangeOptions,
): Promise<ActionsTokenResponse> {
  const body = parseActionsTokenBody(options.body);
  const requestedProfile = tokenPermissionProfile(body);
  const job = await verifyGitHubActionsJob({ ...options, oidcToken: oidcToken(body) });
  if (requestedProfile !== job.profile) {
    throw httpError(
      "GitHub Actions job is not authorized for the requested permission profile.",
      403,
    );
  }
  const token = await options.tokenProvider.tokenForRepository({
    owner: job.owner,
    profile: job.profile,
    repo: job.repo,
  });
  return { expires_in: 3600, token };
}

export async function verifyGitHubActionsJob(
  options: GitHubActionsJobVerificationOptions,
): Promise<VerifiedGitHubActionsJob> {
  const claims = await options.verifier.verify(options.oidcToken, options.audience);
  assertVerifiedClaims(claims);
  assertTrustedWorkflowRef(
    claims.jobWorkflowRef,
    options.trustedWorkflowRefPattern || defaultTrustedWorkflowRefPattern,
  );
  const { owner, repo } = splitRepository(claims.repository);
  const checkRun = await actionsCheckRun({ ...options, claims, owner, repo });
  assertMatchingCheckRun(claims, checkRun);
  const profile = runnerPermissionProfileForGitHubActionsJob({
    checkRunName: checkRun.name,
    jobWorkflowRef: claims.jobWorkflowRef,
  });
  if (!profile) {
    throw httpError("GitHub Actions check run is not authorized for GitVibe hosted auth.", 403);
  }
  return { checkRunName: checkRun.name, claims, owner, profile, repo };
}

function parseActionsTokenBody(body: string): ActionsTokenRequestBody {
  try {
    const parsed = JSON.parse(body || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw httpError("actions token request body must be a JSON object.", 400);
    }
    return parsed as ActionsTokenRequestBody;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw httpError("actions token request body must be valid JSON.", 400);
    }
    throw error;
  }
}

function tokenPermissionProfile(
  body: ActionsTokenRequestBody,
): GitHubActionsRunnerPermissionProfile {
  const value = body.permissionProfile || body.permission_profile;
  if (typeof value !== "string" || !value.trim()) {
    throw httpError("permissionProfile is required.", 400);
  }
  const profile = value.trim();
  if (!isGitHubActionsRunnerPermissionProfile(profile)) {
    throw httpError("unsupported GitHub App token permission profile.", 400);
  }
  return profile;
}

function oidcToken(body: ActionsTokenRequestBody): string {
  const value = body.oidcToken || body.oidc_token || "";
  if (!value.trim()) throw httpError("oidcToken is required.", 400);
  return value;
}

function claimsFromPayload(payload: JWTPayload): GitHubActionsClaims {
  return {
    checkRunId: positiveIntegerClaim(payload, "check_run_id"),
    jobWorkflowRef: requiredClaim(payload, "job_workflow_ref"),
    repository: requiredClaim(payload, "repository"),
    repositoryId: requiredClaim(payload, "repository_id"),
    repositoryOwner: requiredClaim(payload, "repository_owner"),
    sha: requiredClaim(payload, "sha"),
    workflowRef: requiredClaim(payload, "workflow_ref"),
  };
}

async function actionsCheckRun(
  options: Pick<GitHubActionsJobVerificationOptions, "client" | "tokenProvider"> & {
    claims: GitHubActionsClaims;
    owner: string;
    repo: string;
  },
): Promise<{ head_sha: string; name: string }> {
  const token = await options.tokenProvider.tokenForRepository({
    owner: options.owner,
    profile: "server-checks-read",
    repo: options.repo,
  });
  const checkRun = await options.client.request<{ head_sha?: string; name?: string }>({
    method: "GET",
    path: `/repos/${options.owner}/${options.repo}/check-runs/${options.claims.checkRunId}`,
    token,
  });
  if (!checkRun.name || !checkRun.head_sha) {
    throw httpError("GitHub check run response was missing name or head_sha.", 502);
  }
  return { head_sha: checkRun.head_sha, name: checkRun.name };
}

function assertMatchingCheckRun(
  claims: GitHubActionsClaims,
  checkRun: { head_sha: string; name: string },
): void {
  if (checkRun.head_sha !== claims.sha) {
    throw httpError("GitHub Actions OIDC sha does not match the check run head SHA.", 403);
  }
}

function requiredClaim(payload: JWTPayload, name: string): string {
  const value = payload[name];
  if (typeof value !== "string" || !value.trim()) {
    throw httpError(`GitHub Actions OIDC claim ${name} is required.`, 401);
  }
  return value;
}

function positiveIntegerClaim(payload: JWTPayload, name: string): string {
  const value = payload[name];
  const normalized =
    typeof value === "number" && Number.isInteger(value)
      ? String(value)
      : requiredClaim(payload, name);
  assertPositiveIntegerClaim(normalized, name);
  return normalized;
}

function assertVerifiedClaims(claims: GitHubActionsClaims): void {
  assertPositiveIntegerClaim(claims.checkRunId, "check_run_id");
  for (const [name, value] of Object.entries({
    job_workflow_ref: claims.jobWorkflowRef,
    repository: claims.repository,
    repository_id: claims.repositoryId,
    repository_owner: claims.repositoryOwner,
    sha: claims.sha,
    workflow_ref: claims.workflowRef,
  })) {
    if (typeof value !== "string" || !value.trim()) {
      throw httpError(`GitHub Actions OIDC claim ${name} is required.`, 401);
    }
  }
}

function assertPositiveIntegerClaim(value: string, name: string): void {
  if (!/^[1-9]\d*$/.test(value)) {
    throw httpError(`GitHub Actions OIDC claim ${name} must be a positive integer.`, 401);
  }
}

function assertTrustedWorkflowRef(value: string, pattern: RegExp): void {
  if (!pattern.test(value)) {
    throw httpError("GitHub Actions OIDC job_workflow_ref is not trusted.", 403);
  }
}

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
