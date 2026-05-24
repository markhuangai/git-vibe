export interface ConsumerStarterFile {
  content: string;
  relativePath: string;
  sourcePath: string;
}

interface GitHubContentEntry {
  content?: unknown;
  encoding?: unknown;
  path?: unknown;
  type?: unknown;
}

const consumerStarterRoot = "examples/consumer";
const repositoryContentsUrl = "https://api.github.com/repos/markhuangai/git-vibe/contents";
const maxStarterFileBytes = 128 * 1024;

export async function fetchConsumerStarterFiles(options: {
  fetchImpl?: typeof fetch;
  releaseTag: string;
}): Promise<ConsumerStarterFile[]> {
  const fetchImpl = options.fetchImpl || fetch;
  const files = await fetchDirectoryFiles(fetchImpl, options.releaseTag, consumerStarterRoot);

  if (files.length === 0) {
    throw invalidStarterBundleError(options.releaseTag, `${consumerStarterRoot} contains no files`);
  }

  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function fetchDirectoryFiles(
  fetchImpl: typeof fetch,
  releaseTag: string,
  path: string,
): Promise<ConsumerStarterFile[]> {
  const data = await fetchGitHubJson(fetchImpl, contentsUrl(path, releaseTag), releaseTag);
  if (!Array.isArray(data)) {
    throw invalidStarterBundleError(releaseTag, `${path} is not a directory`);
  }

  const fileGroups = await Promise.all(
    data.map((entry) => fetchEntryFiles(fetchImpl, releaseTag, asContentEntry(entry))),
  );
  return fileGroups.flat();
}

async function fetchEntryFiles(
  fetchImpl: typeof fetch,
  releaseTag: string,
  entry: GitHubContentEntry,
): Promise<ConsumerStarterFile[]> {
  const path = entryPath(entry, releaseTag);
  relativeConsumerPath(path, releaseTag);
  const type = entryType(entry, releaseTag, path);

  if (type === "dir") return fetchDirectoryFiles(fetchImpl, releaseTag, path);
  if (type === "file") return [await fetchFile(fetchImpl, releaseTag, path)];

  throw invalidStarterBundleError(releaseTag, `${path} has unsupported type ${type}`);
}

async function fetchFile(
  fetchImpl: typeof fetch,
  releaseTag: string,
  path: string,
): Promise<ConsumerStarterFile> {
  const data = asContentEntry(
    await fetchGitHubJson(fetchImpl, contentsUrl(path, releaseTag), releaseTag),
  );

  if (data.type !== "file" || typeof data.content !== "string" || data.encoding !== "base64") {
    throw invalidStarterBundleError(releaseTag, `${path} is not a base64 file`);
  }

  const encodedContent = data.content.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/=]*$/.test(encodedContent)) {
    throw invalidStarterBundleError(releaseTag, `${path} has invalid base64 content`);
  }

  const content = Buffer.from(encodedContent, "base64");
  if (content.byteLength > maxStarterFileBytes) {
    throw invalidStarterBundleError(releaseTag, `${path} is larger than 128KiB`);
  }

  return {
    content: content.toString("utf8"),
    relativePath: relativeConsumerPath(path, releaseTag),
    sourcePath: path,
  };
}

async function fetchGitHubJson(
  fetchImpl: typeof fetch,
  url: URL,
  releaseTag: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "git-vibe-setup",
        "x-github-api-version": "2022-11-28",
      },
    });
  } catch {
    throw unavailableStarterBundleError(releaseTag);
  }

  if (!response.ok) throw unavailableStarterBundleError(releaseTag);

  try {
    return await response.json();
  } catch {
    throw unavailableStarterBundleError(releaseTag);
  }
}

function contentsUrl(path: string, releaseTag: string): URL {
  const url = new URL(`${repositoryContentsUrl}/${encodePath(path)}`);
  url.searchParams.set("ref", releaseTag);
  return url;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function asContentEntry(value: unknown): GitHubContentEntry {
  return typeof value === "object" && value !== null ? value : {};
}

function entryPath(entry: GitHubContentEntry, releaseTag: string): string {
  if (typeof entry.path !== "string") {
    throw invalidStarterBundleError(releaseTag, "a content entry is missing path");
  }
  return entry.path;
}

function entryType(entry: GitHubContentEntry, releaseTag: string, path: string): string {
  if (typeof entry.type !== "string") {
    throw invalidStarterBundleError(releaseTag, `${path} is missing type`);
  }
  return entry.type;
}

function relativeConsumerPath(path: string, releaseTag: string): string {
  const prefix = `${consumerStarterRoot}/`;
  if (!path.startsWith(prefix)) {
    throw invalidStarterBundleError(releaseTag, `${path} is outside ${consumerStarterRoot}`);
  }

  const relativePath = path.slice(prefix.length);
  if (!isSafeRelativePath(relativePath)) {
    throw invalidStarterBundleError(releaseTag, `${path} has an unsafe relative path`);
  }

  return relativePath;
}

function isSafeRelativePath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return (
    relativePath.length > 0 &&
    !relativePath.startsWith("/") &&
    !relativePath.includes("\\") &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function unavailableStarterBundleError(releaseTag: string): Error {
  return new Error(
    `git-vibe-setup could not fetch the GitVibe consumer starter from markhuangai/git-vibe@${releaseTag} because the GitHub content service is unavailable. No files were written.`,
  );
}

function invalidStarterBundleError(releaseTag: string, detail: string): Error {
  return new Error(
    `git-vibe-setup found an invalid GitVibe consumer starter at markhuangai/git-vibe@${releaseTag}: ${detail}. No files were written.`,
  );
}
