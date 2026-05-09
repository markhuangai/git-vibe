export interface GitHubRequest {
  apiVersion?: string;
  body?: unknown;
  method: string;
  path: string;
  retry?: GitHubRetryOptions;
  token: string;
}

interface GitHubRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
}

export class GitHubClient {
  readonly apiBaseUrl: string;
  readonly retryBaseDelayMs: number;

  constructor(options: { apiBaseUrl?: string; retryBaseDelayMs?: number } = {}) {
    this.apiBaseUrl = options.apiBaseUrl || process.env.GITHUB_API_URL || "https://api.github.com";
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 750;
  }

  async request<T extends Record<string, unknown> | unknown[] = Record<string, unknown>>({
    apiVersion,
    body,
    method,
    path,
    retry,
    token,
  }: GitHubRequest): Promise<T> {
    const attempts = retryAttempts(method, retry);
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const response = await fetch(`${this.apiBaseUrl}${path}`, {
        body: body ? JSON.stringify(body) : undefined,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-github-api-version": apiVersion || "2022-11-28",
        },
        method,
      });

      if (response.status === 204) return {} as T;

      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (response.ok) return data as T;

      lastError = new Error(
        `GitHub API ${method} ${path} failed: ${response.status} ${JSON.stringify(data)}`,
      );
      if (!shouldRetry(response.status, attempt, attempts)) throw lastError;
      await sleep(backoffDelay(attempt, retry?.baseDelayMs ?? this.retryBaseDelayMs));
    }

    throw lastError || new Error(`GitHub API ${method} ${path} failed`);
  }

  async graphql<T>(query: string, variables: Record<string, unknown>, token: string): Promise<T> {
    const result = await this.request<{ data?: T; errors?: unknown[] }>({
      body: { query, variables },
      method: "POST",
      path: "/graphql",
      retry: graphqlReadOnly(query) ? { attempts: 3 } : undefined,
      token,
    });

    if (result.errors?.length) {
      throw new Error(`GitHub GraphQL failed: ${JSON.stringify(result.errors)}`);
    }

    return result.data as T;
  }
}

function retryAttempts(method: string, retry: GitHubRetryOptions | undefined): number {
  if (retry?.attempts !== undefined) return Math.max(1, retry.attempts);
  return method === "GET" ? 3 : 1;
}

function shouldRetry(status: number, attempt: number, attempts: number): boolean {
  return attempt < attempts && transientStatus.has(status);
}

function backoffDelay(attempt: number, baseDelayMs: number): number {
  return Math.max(0, baseDelayMs) * attempt;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function graphqlReadOnly(query: string): boolean {
  return query.trimStart().startsWith("query ");
}

const transientStatus = new Set([502, 503, 504]);

export function splitRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(`repository must be owner/repo, got ${repository || "<missing>"}`);
  }

  return { owner, repo };
}

export async function repositoryDefaultBranch(options: {
  client: GitHubClient;
  owner: string;
  repo: string;
  token: string;
}): Promise<string> {
  const repository = await options.client.request<{ default_branch?: string }>({
    method: "GET",
    path: `/repos/${options.owner}/${options.repo}`,
    token: options.token,
  });
  if (!repository.default_branch) {
    throw new Error(
      `GitHub repository ${options.owner}/${options.repo} did not return default_branch`,
    );
  }
  return repository.default_branch;
}

export async function repositoryActionsVariable(options: {
  client: GitHubClient;
  name: string;
  owner: string;
  repo: string;
  token: string;
}): Promise<string | undefined> {
  try {
    const variable = await options.client.request<{ value?: string }>({
      method: "GET",
      path: `/repos/${options.owner}/${options.repo}/actions/variables/${encodeURIComponent(options.name)}`,
      token: options.token,
    });
    const value = variable.value?.trim();
    return value || undefined;
  } catch (error) {
    if (isGitHubNotFound(error)) return undefined;
    throw error;
  }
}

function isGitHubNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.includes("404");
}
