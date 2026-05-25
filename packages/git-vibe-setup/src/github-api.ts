const defaultGitHubApiHeaders = {
  accept: "application/vnd.github+json",
  "user-agent": "git-vibe-setup",
  "x-github-api-version": "2022-11-28",
};

export function githubApiHeaders(githubToken?: string): Record<string, string> {
  const headers: Record<string, string> = { ...defaultGitHubApiHeaders };
  const token = normalizeGitHubToken(githubToken);
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

export function githubTokenFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return normalizeGitHubToken(env.GITHUB_TOKEN) || normalizeGitHubToken(env.GH_TOKEN);
}

function normalizeGitHubToken(githubToken: string | undefined): string | undefined {
  const token = githubToken?.trim();
  if (!token) return undefined;
  if (/[\r\n]/.test(token)) {
    throw new Error("git-vibe-setup found an invalid GitHub token value. No files were written.");
  }
  return token;
}
