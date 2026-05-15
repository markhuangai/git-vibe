export interface GitHubRelease {
  created_at?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string;
  tag_name?: string;
}

export class ReleaseLookupError extends Error {}

const releasesUrl = "https://api.github.com/repos/markhuangai/git-vibe/releases";
const releasesPerPage = 100;

export async function latestStableReleaseTag(fetchImpl: typeof fetch = fetch): Promise<string> {
  const releases = await fetchReleases(fetchImpl);
  const release = selectLatestStableRelease(releases);
  if (!release?.tag_name) {
    throw new ReleaseLookupError(
      "git-vibe-setup could not check the latest GitVibe update because no stable release is available. No files were written.",
    );
  }

  return release.tag_name;
}

export function selectLatestStableRelease(releases: GitHubRelease[]): GitHubRelease | undefined {
  return releases
    .filter((release) => !release.draft && !release.prerelease && release.tag_name)
    .sort(compareReleaseFreshness)[0];
}

async function fetchReleases(fetchImpl: typeof fetch): Promise<GitHubRelease[]> {
  const releases: GitHubRelease[] = [];

  for (let page = 1; ; page += 1) {
    const data = await fetchReleasePage(fetchImpl, page);
    releases.push(...data);

    if (data.length < releasesPerPage) return releases;
  }
}

async function fetchReleasePage(fetchImpl: typeof fetch, page: number): Promise<GitHubRelease[]> {
  let response: Response;

  try {
    response = await fetchImpl(releasePageUrl(page), {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "git-vibe-setup",
        "x-github-api-version": "2022-11-28",
      },
    });
  } catch {
    throw unavailableReleaseError();
  }

  if (!response.ok) throw unavailableReleaseError();

  try {
    const data = await response.json();
    return Array.isArray(data) ? (data as GitHubRelease[]) : [];
  } catch {
    throw unavailableReleaseError();
  }
}

function releasePageUrl(page: number): string {
  const url = new URL(releasesUrl);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(releasesPerPage));
  return url.toString();
}

function compareReleaseFreshness(left: GitHubRelease, right: GitHubRelease): number {
  return releaseTime(right) - releaseTime(left);
}

function releaseTime(release: GitHubRelease): number {
  return Date.parse(release.published_at || release.created_at || "") || 0;
}

function unavailableReleaseError(): ReleaseLookupError {
  return new ReleaseLookupError(
    "git-vibe-setup could not check the latest GitVibe update because the GitHub release service is unavailable. No files were written.",
  );
}
