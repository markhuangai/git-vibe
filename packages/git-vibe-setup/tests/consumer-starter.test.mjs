import { describe, expect, it } from "vitest";
import { fetchConsumerStarterFiles } from "../src/consumer-starter.ts";

/** @type {Array<[string, Record<string, unknown>, string]>} */
const malformedStarterCases = [
  ["empty root", { "examples/consumer": [] }, "contains no files"],
  ["root file", { "examples/consumer": fileContent("bad") }, "is not a directory"],
  ["missing entry path", { "examples/consumer": [{}] }, "missing path"],
  [
    "missing entry type",
    { "examples/consumer": [{ path: "examples/consumer/file.txt" }] },
    "is missing type",
  ],
  [
    "unsupported entry type",
    { "examples/consumer": [{ path: "examples/consumer/link", type: "symlink" }] },
    "unsupported type symlink",
  ],
  [
    "non-base64 file",
    {
      "examples/consumer": [{ path: "examples/consumer/file.txt", type: "file" }],
      "examples/consumer/file.txt": { content: "bad", encoding: "utf8", type: "file" },
    },
    "is not a base64 file",
  ],
  [
    "invalid base64",
    {
      "examples/consumer": [{ path: "examples/consumer/file.txt", type: "file" }],
      "examples/consumer/file.txt": { content: "%%%", encoding: "base64", type: "file" },
    },
    "has invalid base64 content",
  ],
  [
    "oversized file",
    {
      "examples/consumer": [{ path: "examples/consumer/file.txt", type: "file" }],
      "examples/consumer/file.txt": {
        content: Buffer.alloc(128 * 1024 + 1).toString("base64"),
        encoding: "base64",
        type: "file",
      },
    },
    "is larger than 128KiB",
  ],
  [
    "outside root",
    {
      "examples/consumer": [{ path: "other/file.txt", type: "file" }],
      "other/file.txt": fileContent("bad"),
    },
    "is outside examples/consumer",
  ],
  [
    "unsafe path",
    {
      "examples/consumer": [{ path: "examples/consumer/../evil", type: "file" }],
      "examples/consumer/../evil": fileContent("bad"),
    },
    "has an unsafe relative path",
  ],
];

describe("consumer starter fetch", () => {
  it("fetches nested files from the release consumer starter", async () => {
    const files = await fetchConsumerStarterFiles({
      fetchImpl: fetchRoutes({
        "examples/consumer": [
          { path: "examples/consumer/.github", type: "dir" },
          { path: "examples/consumer/README.md", type: "file" },
        ],
        "examples/consumer/.github": [
          { path: "examples/consumer/.github/git-vibe.yml", type: "file" },
        ],
        "examples/consumer/.github/git-vibe.yml": fileContent("version: 1\n"),
        "examples/consumer/README.md": fileContent("# Consumer\n"),
      }),
      releaseTag: "v1.2.3",
    });

    expect(files).toEqual([
      {
        content: "version: 1\n",
        relativePath: ".github/git-vibe.yml",
        sourcePath: "examples/consumer/.github/git-vibe.yml",
      },
      {
        content: "# Consumer\n",
        relativePath: "README.md",
        sourcePath: "examples/consumer/README.md",
      },
    ]);
  });

  it.each(malformedStarterCases)(
    "rejects malformed starter content: %s",
    async (_name, routes, message) => {
      await expect(
        fetchConsumerStarterFiles({
          fetchImpl: fetchRoutes(routes),
          releaseTag: "v1.2.3",
        }),
      ).rejects.toThrow(message);
    },
  );

  it("fails closed when GitHub content requests fail", async () => {
    await expect(
      fetchConsumerStarterFiles({
        fetchImpl: fetchRoutes({ "examples/consumer": new Error("offline") }),
        releaseTag: "v1.2.3",
      }),
    ).rejects.toThrow("content service is unavailable");
    await expect(
      fetchConsumerStarterFiles({
        fetchImpl: fetchRoutes({ "examples/consumer": "invalid-json" }),
        releaseTag: "v1.2.3",
      }),
    ).rejects.toThrow("content service is unavailable");
    await expect(
      fetchConsumerStarterFiles({
        fetchImpl: fetchRoutes({}),
        releaseTag: "v1.2.3",
      }),
    ).rejects.toThrow("content service is unavailable");
  });
});

/** @param {string} content */
function fileContent(content) {
  return {
    content: Buffer.from(content).toString("base64"),
    encoding: "base64",
    type: "file",
  };
}

/** @param {Record<string, unknown>} routes */
function fetchRoutes(routes) {
  /** @param {string | URL | globalThis.Request} input */
  return async (input) => {
    const url = new URL(input instanceof globalThis.Request ? input.url : String(input));
    const path = decodeURIComponent(
      url.pathname.slice("/repos/markhuangai/git-vibe/contents/".length),
    );
    const result = routes[path];

    if (result instanceof Error) throw result;
    if (result === "invalid-json") {
      return new globalThis.Response("{", {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    }
    if (result === undefined) return new globalThis.Response("", { status: 404 });
    return new globalThis.Response(JSON.stringify(result), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  };
}
