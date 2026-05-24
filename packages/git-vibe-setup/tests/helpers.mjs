import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
export const workspaceRoot = dirname(dirname(repositoryRoot));

/** @type {string[]} */
const temporaryDirectories = [];

export function cleanupTemporaryDirectories() {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
}

export function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "git-vibe-setup-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** @param {string} directory */
export function workflowNames(directory) {
  return readdirSync(join(directory, "workflows")).sort();
}

/** @param {string} targetPath @param {string} sourceName */
export function workflowFile(targetPath, sourceName) {
  return {
    content: "",
    sourcePath: join("examples", "consumer", ".github", "workflows", sourceName),
    targetPath,
  };
}

/** @param {Partial<import("../src/releases.ts").GitHubRelease>} overrides */
export function release(overrides = {}) {
  return {
    created_at: "2026-05-10T00:00:00Z",
    draft: false,
    prerelease: false,
    published_at: "2026-05-10T00:00:00Z",
    tag_name: "v1.0.0",
    ...overrides,
  };
}

/**
 * @param {import("../src/releases.ts").GitHubRelease[]} releases
 * @param {{ failConsumerFetch?: boolean, missingPaths?: string[] }} [options]
 */
export function fetchGitHubOk(releases, options = {}) {
  const releaseFetch = fetchOk(releases);
  const missingPaths = new Set(options.missingPaths || []);

  /** @param {string | URL | globalThis.Request} input */
  return async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/repos/markhuangai/git-vibe/releases") return releaseFetch();
    if (!url.pathname.startsWith("/repos/markhuangai/git-vibe/contents/")) {
      return new globalThis.Response("", { status: 404 });
    }
    if (options.failConsumerFetch) return new globalThis.Response("", { status: 503 });
    return consumerContentResponse(url, missingPaths);
  };
}

/** @param {{ mock: { calls: Array<[string | URL | globalThis.Request, RequestInit?]> } }} fetchImpl */
export function contentRequestRefs(fetchImpl) {
  const refs = fetchImpl.mock.calls
    .map(([input]) => requestUrl(input))
    .filter((url) => url.pathname.startsWith("/repos/markhuangai/git-vibe/contents/"))
    .map((url) => url.searchParams.get("ref") || "");
  return [...new Set(refs)].sort();
}

/** @param {string | URL | globalThis.Request} input */
export function requestUrl(input) {
  return new URL(input instanceof globalThis.Request ? input.url : String(input));
}

/** @param {import("../src/releases.ts").GitHubRelease[]} data */
export function fetchOk(data) {
  return async () =>
    new globalThis.Response(JSON.stringify(data), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
}

/** @param {URL} url @param {Set<string>} missingPaths */
function consumerContentResponse(url, missingPaths) {
  const repositoryPath = decodeURIComponent(
    url.pathname.slice("/repos/markhuangai/git-vibe/contents/".length),
  );
  const consumerPath = relativeConsumerPath(repositoryPath);
  if (consumerPath && missingPaths.has(consumerPath)) {
    return new globalThis.Response("", { status: 404 });
  }

  const localPath = join(workspaceRoot, repositoryPath);
  if (!existsSync(localPath)) return new globalThis.Response("", { status: 404 });

  const stat = lstatSync(localPath);
  if (stat.isDirectory())
    return jsonResponse(directoryContent(repositoryPath, localPath, missingPaths));
  if (stat.isFile()) {
    return jsonResponse({
      content: readFileSync(localPath).toString("base64"),
      encoding: "base64",
      path: repositoryPath,
      type: "file",
    });
  }
  return new globalThis.Response("", { status: 404 });
}

/** @param {string} repositoryPath @param {string} localPath @param {Set<string>} missingPaths */
function directoryContent(repositoryPath, localPath, missingPaths) {
  return readdirSync(localPath, { withFileTypes: true })
    .map((entry) => {
      const entryPath = join(repositoryPath, entry.name);
      return {
        path: entryPath,
        type: entry.isDirectory() ? "dir" : "file",
      };
    })
    .filter((entry) => !missingPaths.has(relativeConsumerPath(entry.path)));
}

/** @param {string} repositoryPath */
function relativeConsumerPath(repositoryPath) {
  return relative(join("examples", "consumer"), repositoryPath);
}

/** @param {unknown} data */
function jsonResponse(data) {
  return new globalThis.Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}
