export interface GitHubRequest {
  body?: unknown;
  method: string;
  path: string;
  token: string;
}

export class GitHubClient {
  readonly apiBaseUrl: string;

  constructor(options: { apiBaseUrl?: string } = {}) {
    this.apiBaseUrl = options.apiBaseUrl || process.env.GITHUB_API_URL || "https://api.github.com";
  }

  async request<T extends Record<string, unknown> | unknown[] = Record<string, unknown>>({
    body,
    method,
    path,
    token,
  }: GitHubRequest): Promise<T> {
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      method,
    });

    if (response.status === 204) return {} as T;

    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(
        `GitHub API ${method} ${path} failed: ${response.status} ${JSON.stringify(data)}`,
      );
    }

    return data as T;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>, token: string): Promise<T> {
    const result = await this.request<{ data?: T; errors?: unknown[] }>({
      body: { query, variables },
      method: "POST",
      path: "/graphql",
      token,
    });

    if (result.errors?.length) {
      throw new Error(`GitHub GraphQL failed: ${JSON.stringify(result.errors)}`);
    }

    return result.data as T;
  }
}

export function splitRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(`repository must be owner/repo, got ${repository || "<missing>"}`);
  }

  return { owner, repo };
}
