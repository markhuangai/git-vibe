import { createPrivateKey, type KeyObject } from "node:crypto";
import { SignJWT } from "jose";
import { GitHubClient } from "../shared/github.js";
import {
  permissionsForProfile,
  type GitHubAppPermissionProfile,
} from "../shared/github-app-permissions.js";

export {
  isGitHubActionsRunnerPermissionProfile,
  isGitHubAppPermissionProfile,
  permissionsForProfile,
  runnerPermissionProfileForGitHubActionsJob,
  type GitHubActionsJobIdentity,
  type GitHubActionsRunnerPermissionProfile,
  type GitHubAppPermission,
  type GitHubAppPermissionProfile,
  type GitHubAppServerPermissionProfile,
} from "../shared/github-app-permissions.js";

export interface InstallationTokenRequest {
  installationId?: number | string;
  owner: string;
  profile: GitHubAppPermissionProfile;
  repo: string;
}

export interface InstallationTokenProvider {
  tokenForRepository(request: InstallationTokenRequest): Promise<string>;
}

interface GitHubAppInstallationTokenProviderOptions {
  appId: string;
  client?: GitHubClient;
  now?: () => Date;
  privateKey: string;
}

interface CachedInstallationToken {
  expiresAtMs: number;
  token: string;
}

interface InstallationTokenResponse extends Record<string, unknown> {
  expires_at?: string;
  token?: string;
}

interface RepositoryInstallationResponse extends Record<string, unknown> {
  id?: number;
}

const tokenRefreshSkewMs = 5 * 60 * 1000;

export class GitHubAppInstallationTokenProvider implements InstallationTokenProvider {
  private readonly appId: string;
  private readonly cache = new Map<string, CachedInstallationToken>();
  private readonly client: GitHubClient;
  private readonly installationIds = new Map<string, string>();
  private readonly now: () => Date;
  private readonly privateKey: string;
  private signingKey: KeyObject | undefined;

  constructor(options: GitHubAppInstallationTokenProviderOptions) {
    this.appId = options.appId;
    this.client = options.client || new GitHubClient();
    this.now = options.now || (() => new Date());
    this.privateKey = normalizePrivateKey(options.privateKey);
  }

  async tokenForRepository(request: InstallationTokenRequest): Promise<string> {
    const installationId = request.installationId
      ? normalizedInstallationId(request.installationId)
      : await this.installationIdForRepository(request.owner, request.repo);
    const cacheKey = installationTokenCacheKey({ ...request, installationId });
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAtMs - tokenRefreshSkewMs > this.now().getTime()) {
      return cached.token;
    }

    const appJwt = await this.appJwt();
    const response = await this.client.request<InstallationTokenResponse>({
      body: {
        permissions: permissionsForProfile(request.profile),
        repositories: [request.repo],
      },
      method: "POST",
      path: `/app/installations/${installationId}/access_tokens`,
      token: appJwt,
    });

    if (!response.token || !response.expires_at) {
      throw new Error("GitHub App installation token response was missing token or expires_at.");
    }

    this.cache.set(cacheKey, {
      expiresAtMs: Date.parse(response.expires_at),
      token: response.token,
    });
    return response.token;
  }

  private async appJwt(): Promise<string> {
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    const key = await this.privateSigningKey();
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt(nowSeconds - 60)
      .setIssuer(this.appId)
      .setExpirationTime(nowSeconds + 9 * 60)
      .sign(key);
  }

  private async privateSigningKey(): Promise<KeyObject> {
    this.signingKey ||= createPrivateKey(this.privateKey);
    return this.signingKey;
  }

  private async installationIdForRepository(owner: string, repo: string): Promise<string> {
    const cacheKey = `${owner}/${repo}`;
    const cached = this.installationIds.get(cacheKey);
    if (cached) return cached;

    const appJwt = await this.appJwt();
    const response = await this.client.request<RepositoryInstallationResponse>({
      method: "GET",
      path: `/repos/${owner}/${repo}/installation`,
      token: appJwt,
    });
    if (!response.id) {
      throw new Error(`GitHub App installation not found for ${owner}/${repo}.`);
    }

    const installationId = normalizedInstallationId(response.id);
    this.installationIds.set(cacheKey, installationId);
    return installationId;
  }
}

function installationTokenCacheKey(request: InstallationTokenRequest): string {
  return [request.installationId, request.owner, request.repo, request.profile].join(":");
}

function normalizedInstallationId(value: string | number): string {
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error("GitHub App installation ID must be a positive integer.");
  }
  return normalized;
}

function normalizePrivateKey(value: string): string {
  return value.replace(/\\n/g, "\n").trim();
}
