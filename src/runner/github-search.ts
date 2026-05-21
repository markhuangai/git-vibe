import { z } from "zod";
import { splitRepository, type GitHubRequest } from "../shared/github.js";

interface GitHubSearchOptions {
  github?: {
    client: {
      request<T extends Record<string, unknown> | unknown[] = Record<string, unknown>>(
        request: GitHubRequest,
      ): Promise<T>;
    };
    repository: string;
    token: string;
  };
}

interface SearchResponse extends Record<string, unknown> {
  items?: Array<Record<string, unknown>>;
  total_count?: number;
}

export function createGitHubSearch(options: GitHubSearchOptions) {
  return {
    description: [
      "Search the current GitHub repository for project material without loading websites.",
      "Use this for issue, pull request, and code search related to the active GitVibe artifact.",
      "The search is always constrained to the current repository.",
    ].join(" "),
    inputSchema: z.object({
      kind: z.enum(["all", "code", "issues"]).optional().describe("GitHub material to search."),
      limit: z.number().int().min(1).max(10).optional().describe("Maximum results per category."),
      query: z.string().min(2).describe("Search terms. Repository qualifiers are ignored."),
    }),
    execute: async (input: { kind?: "all" | "code" | "issues"; limit?: number; query: string }) => {
      const { kind = "all", limit = 5, query } = input;
      try {
        if (!options.github) return "Error [github-search]: GitHub context is unavailable.";
        const searchQuery = repositorySearchQuery(query, options.github.repository);
        const perPage = String(limit);
        const sections: string[] = [];
        if (kind === "all" || kind === "issues") {
          sections.push(await issueSearch({ ...options, perPage, searchQuery }));
        }
        if (kind === "all" || kind === "code") {
          sections.push(await codeSearch({ ...options, perPage, searchQuery }));
        }
        return sections.filter(Boolean).join("\n\n") || "No GitHub search results.";
      } catch (error) {
        return `Error [github-search]: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

function repositorySearchQuery(query: string, repository: string): string {
  const sanitized = query
    .replace(/\b(?:org|repo|user):\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!sanitized) throw new Error("query must include search terms beyond GitHub qualifiers.");
  const { owner, repo } = splitRepository(repository);
  return `${sanitized} repo:${owner}/${repo}`;
}

async function issueSearch(
  options: GitHubSearchOptions & { perPage: string; searchQuery: string },
) {
  if (!options.github) return "";
  const result = await options.github.client.request<SearchResponse>({
    method: "GET",
    path: `/search/issues?q=${encodeURIComponent(options.searchQuery)}&per_page=${options.perPage}`,
    token: options.github.token,
  });
  return formatIssueResults(result.items || []);
}

async function codeSearch(options: GitHubSearchOptions & { perPage: string; searchQuery: string }) {
  if (!options.github) return "";
  const result = await options.github.client.request<SearchResponse>({
    method: "GET",
    path: `/search/code?q=${encodeURIComponent(options.searchQuery)}&per_page=${options.perPage}`,
    token: options.github.token,
  });
  return formatCodeResults(result.items || []);
}

function formatIssueResults(items: Array<Record<string, unknown>>): string {
  const lines = ["Issues and pull requests:"];
  if (items.length === 0) return `${lines[0]}\n- No matches.`;
  for (const item of items) {
    const number = numberValue(item.number);
    const title = stringValue(item.title) || "<untitled>";
    const state = stringValue(item.state);
    const url = stringValue(item.html_url);
    lines.push(
      `- ${number ? `#${number} ` : ""}${title}${state ? ` (${state})` : ""}${url ? ` ${url}` : ""}`,
    );
  }
  return lines.join("\n");
}

function formatCodeResults(items: Array<Record<string, unknown>>): string {
  const lines = ["Code:"];
  if (items.length === 0) return `${lines[0]}\n- No matches.`;
  for (const item of items) {
    const path = stringValue(item.path) || "<unknown path>";
    const url = stringValue(item.html_url);
    lines.push(`- ${path}${url ? ` ${url}` : ""}`);
  }
  return lines.join("\n");
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
