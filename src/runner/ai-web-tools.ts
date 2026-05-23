import { z } from "zod";
import {
  domainInputAllowedByPolicy,
  type AiWebPolicy,
  urlAllowedByPolicy,
} from "./ai-web-policy.js";

const maxWebFetchChars = 100000;

export function createAllowlistedWebFetch(policy: AiWebPolicy) {
  return {
    description: `Fetch a URL only when its host matches ai.security.web.allowed_domains: ${policy.allowedDomains.join(", ")}.`,
    inputSchema: z.object({
      url: z.string().url().describe("The allowlisted URL to fetch."),
    }),
    execute: async (input: { url: string }) => {
      const { url } = input;
      if (!urlAllowedByPolicy(url, policy)) {
        return "Error [web-fetch]: URL is blocked by ai.security.web.allowed_domains.";
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

export function createAllowlistedWebSearch(policy: AiWebPolicy) {
  return {
    description: `Validate an allowlisted web search request. General web search requires a configured search backend; use github_search for repository material.`,
    inputSchema: z.object({
      allowed_domains: z.array(z.string()).optional(),
      blocked_domains: z.array(z.string()).optional(),
      query: z.string().min(2).describe("The search query to use."),
    }),
    execute: async (input: { allowed_domains?: string[] }) => {
      const { allowed_domains } = input;
      const requested = allowed_domains || policy.allowedDomains;
      const blocked = requested.filter((domain) => !domainInputAllowedByPolicy(domain, policy));
      if (blocked.length > 0) {
        return `Error [web-search]: requested domains are blocked by ai.security.web.allowed_domains: ${blocked.join(", ")}`;
      }
      return "Error [web-search]: no external web search backend is configured. Use github_search for repository material.";
    },
  };
}
