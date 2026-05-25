import { describe, expect, it, vi } from "vitest";
import {
  latestReleaseTag,
  latestStableReleaseTag,
  selectLatestRelease,
  selectLatestStableRelease,
} from "../src/releases.ts";

describe("stable release selection", () => {
  it("ignores draft and prerelease releases when choosing the latest stable tag", () => {
    const releaseTag = selectLatestStableRelease([
      release({ draft: true, published_at: "2026-05-17T00:00:00Z", tag_name: "v3.0.0" }),
      release({ prerelease: true, published_at: "2026-05-16T00:00:00Z", tag_name: "v2.0.0-rc1" }),
      release({ published_at: "2026-05-15T00:00:00Z", tag_name: "v1.3.0" }),
      release({ published_at: "2026-05-14T00:00:00Z", tag_name: "v1.2.9" }),
    ])?.tag_name;

    expect(releaseTag).toBe("v1.3.0");
  });

  it("can include prereleases when choosing the latest release tag", async () => {
    const releases = [
      release({ published_at: "2026-05-15T00:00:00Z", tag_name: "v1.3.0" }),
      release({
        prerelease: true,
        published_at: "2026-05-16T00:00:00Z",
        tag_name: "v1.4.0-rc.1",
      }),
    ];

    expect(selectLatestRelease(releases, { includePrereleases: true })?.tag_name).toBe(
      "v1.4.0-rc.1",
    );
    await expect(
      latestReleaseTag({ fetchImpl: fetchOk(releases), includePrereleases: true }),
    ).resolves.toBe("v1.4.0-rc.1");
  });

  it("falls back to created_at when published_at is unavailable", () => {
    const releaseTag = selectLatestStableRelease([
      release({ created_at: "2026-05-14T00:00:00Z", published_at: undefined, tag_name: "v1.2.9" }),
      release({ created_at: "2026-05-15T00:00:00Z", published_at: undefined, tag_name: "v1.3.0" }),
    ])?.tag_name;

    expect(releaseTag).toBe("v1.3.0");
  });

  it("checks later release pages before reporting that no stable release exists", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      release({
        draft: index % 2 === 0,
        prerelease: index % 2 === 1,
        published_at: `2026-05-${String(14 - Math.floor(index / 10)).padStart(2, "0")}T00:00:00Z`,
        tag_name: `v9.0.0-${index}`,
      }),
    );
    const fetchImpl = vi.fn(
      fetchPages([
        firstPage,
        [release({ published_at: "2026-05-01T00:00:00Z", tag_name: "v1.2.3" })],
      ]),
    );

    await expect(latestStableReleaseTag(fetchImpl)).resolves.toBe("v1.2.3");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toContain("page=1");
    expect(fetchImpl.mock.calls[0][0]).toContain("per_page=100");
    expect(fetchImpl.mock.calls[1][0]).toContain("page=2");
    expect(fetchImpl.mock.calls[1][0]).toContain("per_page=100");
  });

  it("fails closed when the release request throws or returns invalid JSON", async () => {
    await expect(
      latestStableReleaseTag(async () => Promise.reject(new Error("offline"))),
    ).rejects.toThrow("service is unavailable");
    await expect(
      latestStableReleaseTag(
        async () =>
          new globalThis.Response("{", {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
      ),
    ).rejects.toThrow("service is unavailable");
    await expect(
      latestStableReleaseTag(
        async () =>
          new globalThis.Response(JSON.stringify({ tag_name: "v1.2.3" }), {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
      ),
    ).rejects.toThrow("no stable release is available");
  });
});

describe("release lookup GitHub API requests", () => {
  it("authenticates release lookup requests when a token is available", async () => {
    const fetchImpl = vi.fn(fetchOk([release({ tag_name: "v1.2.3" })]));

    await expect(latestReleaseTag({ fetchImpl, githubToken: "ghs_release" })).resolves.toBe(
      "v1.2.3",
    );

    const calls = /** @type {Array<[string | URL | globalThis.Request, RequestInit?]>} */ (
      /** @type {unknown} */ (fetchImpl.mock.calls)
    );
    expect(new globalThis.Headers(calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer ghs_release",
    );
  });
});

/** @param {Partial<import("../src/releases.ts").GitHubRelease>} overrides */
function release(overrides = {}) {
  return {
    created_at: "2026-05-10T00:00:00Z",
    draft: false,
    prerelease: false,
    published_at: "2026-05-10T00:00:00Z",
    tag_name: "v1.0.0",
    ...overrides,
  };
}

/** @param {import("../src/releases.ts").GitHubRelease[]} data */
function fetchOk(data) {
  return async () =>
    new globalThis.Response(JSON.stringify(data), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
}

/** @param {import("../src/releases.ts").GitHubRelease[][]} pages */
function fetchPages(pages) {
  /** @param {string | URL | globalThis.Request} url */
  return async (url) => {
    const page = Number(new URL(String(url)).searchParams.get("page") || "1");
    const data = pages[page - 1] || [];
    return new globalThis.Response(JSON.stringify(data), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  };
}
