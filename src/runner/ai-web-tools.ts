import { z } from "zod";

const maxWebFetchChars = 100000;

export function createWebFetch() {
  return {
    description:
      "Fetch an HTTP(S) URL for read-only research. Do not submit forms, upload data, or download suspicious files.",
    inputSchema: z.object({
      url: z.string().url().describe("The HTTP(S) URL to fetch."),
    }),
    execute: async (input: { url: string }) => {
      const { url } = input;
      if (!httpUrl(url)) {
        return "Error [web-fetch]: only HTTP(S) URLs are supported.";
      }

      try {
        const response = await fetch(url, {
          headers: { Accept: "text/markdown, text/plain, text/html, */*" },
          signal: AbortSignal.timeout(30000),
        });
        const contentType = response.headers.get("content-type") || "";
        const text = await response.text();
        const truncated = text.length > maxWebFetchChars;
        const body = truncated ? text.slice(0, maxWebFetchChars) : text;
        return [
          `URL: ${url}`,
          `Status: ${response.status}`,
          `Content-Type: ${contentType}`,
          truncated ? "(Content truncated to 100,000 characters)" : "",
          "",
          body,
        ]
          .filter((line) => line !== "")
          .join("\n");
      } catch (error) {
        return `Error [web-fetch]: Failed to fetch ${url}: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    },
  };
}

export function createWebSearch() {
  return {
    description:
      "Request web search for read-only research. General web search requires a configured search backend; use github_search for repository material.",
    inputSchema: z.object({
      allowed_domains: z.array(z.string()).optional(),
      blocked_domains: z.array(z.string()).optional(),
      query: z.string().min(2).describe("The search query to use."),
    }),
    execute: async () => {
      return "Error [web-search]: no external web search backend is configured. Use github_search for repository material.";
    },
  };
}

function httpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
