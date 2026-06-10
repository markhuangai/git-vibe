import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { splitRepository } from "../shared/github.js";
import { isGitHubAppPermissionProfile, type InstallationTokenProvider } from "./github-app-auth.js";

export interface ActionsTokenRequestBody {
  oidcToken?: string;
  oidc_token?: string;
  permissionProfile?: string;
  permission_profile?: string;
}

export interface ActionsTokenExchangeOptions {
  audience: string;
  body: string;
  tokenProvider: InstallationTokenProvider;
  trustedWorkflowRefPattern?: RegExp;
  verifier: GitHubActionsOidcVerifier;
}

export interface ActionsTokenResponse {
  expires_in: number;
  token: string;
}

export interface GitHubActionsClaims {
  jobWorkflowRef: string;
  repository: string;
  repositoryId: string;
  repositoryOwner: string;
  workflowRef: string;
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
  const profile = tokenPermissionProfile(body);
  const claims = await options.verifier.verify(oidcToken(body), options.audience);
  assertTrustedWorkflowRef(
    claims.jobWorkflowRef,
    options.trustedWorkflowRefPattern || defaultTrustedWorkflowRefPattern,
  );
  const { owner, repo } = splitRepository(claims.repository);
  const token = await options.tokenProvider.tokenForRepository({ owner, profile, repo });
  return { expires_in: 3600, token };
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

function tokenPermissionProfile(body: ActionsTokenRequestBody): "runner" {
  const value = body.permissionProfile || body.permission_profile || "runner";
  if (!isGitHubAppPermissionProfile(value) || value !== "runner") {
    throw httpError("unsupported GitHub App token permission profile.", 400);
  }
  return value;
}

function oidcToken(body: ActionsTokenRequestBody): string {
  const value = body.oidcToken || body.oidc_token || "";
  if (!value.trim()) throw httpError("oidcToken is required.", 400);
  return value;
}

function claimsFromPayload(payload: JWTPayload): GitHubActionsClaims {
  return {
    jobWorkflowRef: requiredClaim(payload, "job_workflow_ref"),
    repository: requiredClaim(payload, "repository"),
    repositoryId: requiredClaim(payload, "repository_id"),
    repositoryOwner: requiredClaim(payload, "repository_owner"),
    workflowRef: requiredClaim(payload, "workflow_ref"),
  };
}

function requiredClaim(payload: JWTPayload, name: string): string {
  const value = payload[name];
  if (typeof value !== "string" || !value.trim()) {
    throw httpError(`GitHub Actions OIDC claim ${name} is required.`, 401);
  }
  return value;
}

function assertTrustedWorkflowRef(value: string, pattern: RegExp): void {
  if (!pattern.test(value)) {
    throw httpError("GitHub Actions OIDC job_workflow_ref is not trusted.", 403);
  }
}

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
