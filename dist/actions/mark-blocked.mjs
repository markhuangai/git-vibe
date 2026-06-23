import { createRequire as __gitVibeCreateRequire } from "node:module"; const require = __gitVibeCreateRequire(import.meta.url);

// src/runner/actions/mark-blocked.ts
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// src/shared/github.ts
var GitHubClient = class {
  apiBaseUrl;
  retryBaseDelayMs;
  constructor(options = {}) {
    this.apiBaseUrl = options.apiBaseUrl || process.env.GITHUB_API_URL || "https://api.github.com";
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 750;
  }
  async request({
    apiVersion,
    body,
    method,
    path,
    retry,
    token
  }) {
    const attempts = retryAttempts(method, retry);
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response;
      try {
        response = await fetch(`${this.apiBaseUrl}${path}`, {
          body: body ? JSON.stringify(body) : void 0,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-github-api-version": apiVersion || "2022-11-28"
          },
          method
        });
      } catch (error) {
        throw new Error(
          `GitHub API ${method} ${path} transport failed on attempt ${attempt}: ${transportErrorSummary(error)}`,
          { cause: error }
        );
      }
      if (response.status === 204) return {};
      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (response.ok) return data;
      lastError = new Error(
        `GitHub API ${method} ${path} failed: ${response.status} ${JSON.stringify(data)}`
      );
      if (!shouldRetry(response.status, attempt, attempts)) throw lastError;
      await sleep(backoffDelay(attempt, retry?.baseDelayMs ?? this.retryBaseDelayMs));
    }
    throw lastError || new Error(`GitHub API ${method} ${path} failed`);
  }
  async graphql(query, variables, token) {
    const result = await this.request({
      body: { query, variables },
      method: "POST",
      path: "/graphql",
      retry: graphqlReadOnly(query) ? { attempts: 3 } : void 0,
      token
    });
    if (result.errors?.length) {
      throw new Error(`GitHub GraphQL failed: ${JSON.stringify(result.errors)}`);
    }
    return result.data;
  }
};
function retryAttempts(method, retry) {
  if (retry?.attempts !== void 0) return Math.max(1, retry.attempts);
  return method === "GET" ? 3 : 1;
}
function shouldRetry(status, attempt, attempts) {
  return attempt < attempts && transientStatus.has(status);
}
function backoffDelay(attempt, baseDelayMs) {
  return Math.max(0, baseDelayMs) * attempt;
}
function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}
function transportErrorSummary(error) {
  const parts = errorParts(error);
  const cause = error instanceof Error ? errorParts(error.cause) : [];
  return [...parts, ...cause.map((part) => `cause_${part}`)].join(" ") || String(error);
}
function errorParts(error) {
  if (!error || typeof error !== "object") return [];
  const record = error;
  return [
    stringPart("name", record.name),
    stringPart("message", record.message),
    stringPart("code", record.code)
  ].filter((part) => Boolean(part));
}
function stringPart(name, value) {
  if (typeof value !== "string" || !value.trim()) return void 0;
  return `${name}=${JSON.stringify(value.trim())}`;
}
function graphqlReadOnly(query) {
  return query.trimStart().startsWith("query ");
}
var transientStatus = /* @__PURE__ */ new Set([502, 503, 504]);
function splitRepository(repository) {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(`repository must be owner/repo, got ${repository || "<missing>"}`);
  }
  return { owner, repo };
}

// src/shared/labels.ts
var gitVibeLabels = {
  approved: {
    color: "0E8A16",
    description: "Trusted actor approved GitVibe materialization automation.",
    name: "git-vibe:approved"
  },
  acceptRisk: {
    color: "B60205",
    description: "Trusted actor accepted prompt-injection risk for one GitVibe rerun.",
    name: "git-vibe:accept-risk"
  },
  blocked: {
    color: "D93F0B",
    description: "GitVibe is blocked by missing or contradictory information.",
    name: "gvi:blocked"
  },
  inProgress: {
    color: "FBCA04",
    description: "GitVibe deterministic write work is in progress.",
    name: "gvi:in-progress"
  },
  investigate: {
    color: "C5DEF5",
    description: "Trusted actor requested GitVibe investigation automation.",
    name: "git-vibe:investigate"
  },
  investigated: {
    color: "0E8A16",
    description: "GitVibe investigation completed and validation can proceed.",
    name: "gvi:investigated"
  },
  investigating: {
    color: "1D76DB",
    description: "GitVibe is investigating a bug or request.",
    name: "gvi:investigating"
  },
  needsDiscussion: {
    color: "5319E7",
    description: "Feature request should be discussed before issue materialization.",
    name: "gvi:needs-discussion"
  },
  prOpened: {
    color: "0E8A16",
    description: "GitVibe opened or updated a pull request before automation was disabled.",
    name: "gvi:pr-opened"
  },
  prApproved: {
    color: "0E8A16",
    description: "GitVibe pull request was approved by a trusted reviewer.",
    name: "gvi:pr-approved"
  },
  prMerged: {
    color: "5319E7",
    description: "GitVibe pull request was merged while the issue awaits default-branch closure.",
    name: "gvi:pr-merged"
  },
  readyForApproval: {
    color: "FBCA04",
    description: "GitVibe believes the issue or pull request is ready for approval.",
    name: "gvi:ready-for-approval"
  },
  review: {
    color: "C5DEF5",
    description: "Trusted actor requested GitVibe pull request review automation.",
    name: "git-vibe:review"
  },
  reviewing: {
    color: "1D76DB",
    description: "GitVibe is reviewing a pull request.",
    name: "gvi:reviewing"
  },
  story: {
    color: "5319E7",
    description: "Implementation issue materialized from a GitVibe discussion.",
    name: "gvi:story"
  },
  validate: {
    color: "C5DEF5",
    description: "Trusted actor requested GitVibe validation automation.",
    name: "git-vibe:validate"
  },
  validated: {
    color: "0E8A16",
    description: "GitVibe validation completed and materialization is allowed.",
    name: "gvi:validated"
  },
  validating: {
    color: "1D76DB",
    description: "GitVibe is validating an issue or discussion.",
    name: "gvi:validating"
  }
};
var gitVibeManagedLabelList = Object.values(gitVibeLabels);
var gitVibeLabelList = [...gitVibeManagedLabelList];
var gitVibeLabelNames = new Set(gitVibeLabelList.map((label) => label.name));
var gitVibeRuntimeLabelNames = new Set(
  Object.values(gitVibeLabels).filter((label) => label.name.startsWith("gvi:")).map((label) => label.name)
);

// src/runner/logging.ts
var tokenPatterns = [
  /\bgithub_pat_[A-Za-z0-9_]+\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]+\b/g,
  /\bsk-[A-Za-z0-9_-]+\b/g
];
function redactLogText(value) {
  let redacted = value;
  for (const pattern of tokenPatterns) {
    redacted = redacted.replace(pattern, "<redacted>");
  }
  for (const [name, secret] of Object.entries(process.env)) {
    if (!sensitiveName(name) || !secret || secret.length < 6) continue;
    redacted = redacted.split(secret).join(`<redacted:${name}>`);
  }
  for (const [bundle, name, secret] of envBundleSecrets()) {
    redacted = redacted.split(secret).join(`<redacted:${bundle}.${name}>`);
  }
  return redacted;
}
function sensitiveName(name) {
  return /(^|_)(AUTH|AUTHORIZATION|CREDENTIALS?|KEY|PASSWORD|SECRET|TOKEN)(_|$)/i.test(name);
}
function envBundleSecrets() {
  return ["GITVIBE_AI_ENV_JSON", "GITVIBE_MCP_ENV_JSON"].flatMap((bundle) => bundleSecrets(bundle));
}
function bundleSecrets(bundle) {
  const raw = process.env[bundle];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed).filter((entry) => typeof entry[1] === "string").filter(([, value]) => value.length >= 6).map(([name, value]) => [bundle, name, value]);
  } catch {
    return [];
  }
}

// src/shared/hosted-app.ts
var defaultActionsTokenUrl = "https://git-vibe.markhuang.ai/actions/token";

// src/shared/github-app-permissions.ts
var runnerPermissionProfiles = /* @__PURE__ */ new Set([
  "runner-read",
  "runner-status-write",
  "runner-workflow-write"
]);
function isGitHubActionsRunnerPermissionProfile(value) {
  return runnerPermissionProfiles.has(value);
}

// src/runner/actions/github-app-token.ts
async function githubAppToken(runtime = {}) {
  const env = runtime.env || process.env;
  const existingToken = env.GITVIBE_GITHUB_APP_TOKEN?.trim();
  if (existingToken) return existingToken;
  const permissionProfile = requiredPermissionProfile(runtime.permissionProfile);
  const fetchImpl = runtime.fetch || fetch;
  const oidcToken = await requestActionsOidcToken(env, fetchImpl);
  return exchangeActionsOidcToken(env, fetchImpl, oidcToken, permissionProfile);
}
async function requestActionsOidcToken(env, fetchImpl) {
  const requestUrl = requiredEnv(
    env,
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_URL is required. Add permissions: id-token: write to this job."
  );
  const requestToken = requiredEnv(
    env,
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN is required. Add permissions: id-token: write to this job."
  );
  const url = new URL(requestUrl);
  url.searchParams.set("audience", actionsOidcAudience(env));
  const response = await fetchWithTimeout(env, fetchImpl, "GitHub Actions OIDC token", url, {
    headers: { authorization: `Bearer ${requestToken}` }
  });
  const data = await responseJson(response, "GitHub Actions OIDC token");
  if (!data.value) throw new Error("GitHub Actions OIDC token response was missing value.");
  return data.value;
}
async function exchangeActionsOidcToken(env, fetchImpl, oidcToken, permissionProfile) {
  const response = await fetchWithTimeout(
    env,
    fetchImpl,
    "GitVibe actions token",
    actionsTokenUrl(env),
    {
      body: JSON.stringify({ oidcToken, permissionProfile }),
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      method: "POST"
    }
  );
  const data = await responseJson(response, "GitVibe actions token");
  if (!data.token) throw new Error("GitVibe actions token response was missing token.");
  return data.token;
}
function requiredPermissionProfile(value) {
  if (value && isGitHubActionsRunnerPermissionProfile(value)) return value;
  if (value) throw new Error(`Unsupported GitHub App token permission profile: ${value}.`);
  throw new Error("GitHub App permission profile is required when requesting a hosted token.");
}
async function responseJson(response, label) {
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${label} request failed: ${response.status}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${label} response must be a JSON object.`);
  }
  return data;
}
async function fetchWithTimeout(env, fetchImpl, label, input, init) {
  const timeoutMs = requestTimeoutMs(env);
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetchImpl(input, { ...init || {}, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new Error(`${label} request timed out after ${timeoutMs}ms.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
function requestTimeoutMs(env) {
  const raw = env.GITVIBE_HTTP_TIMEOUT_MS?.trim();
  if (!raw) return 15e3;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("GITVIBE_HTTP_TIMEOUT_MS must be a positive integer.");
  }
  return value;
}
function actionsTokenUrl(env) {
  return env.GITVIBE_ACTIONS_TOKEN_URL || defaultActionsTokenUrl;
}
function actionsOidcAudience(env) {
  return env.GITVIBE_ACTIONS_OIDC_AUDIENCE || actionsTokenUrl(env);
}
function requiredEnv(env, name, message) {
  const value = env[name]?.trim();
  if (!value) throw new Error(message);
  return value;
}

// src/runner/actions/mark-blocked.ts
async function markBlocked(runtime = {}) {
  const env = runtime.env ?? process.env;
  const error = runtime.error ?? console.error;
  const log = runtime.log ?? console.log;
  try {
    const token = await resolveGitHubToken(runtime, env);
    const repository = requiredEnv2(env, "GITHUB_REPOSITORY");
    const issueNumber = requiredEnv2(env, "GITVIBE_ISSUE_NUMBER");
    const { owner, repo } = splitRepository(repository);
    const dryRun = isTrue(env.GITVIBE_DRY_RUN);
    if (dryRun) {
      log(`dry-run: would mark issue #${issueNumber} blocked after an incomplete run`);
      return 0;
    }
    const client = runtime.client ?? new GitHubClient();
    await markIssueBlocked({ client, dryRun, issueNumber, owner, repo, token });
    log(`marked issue #${issueNumber} blocked after an incomplete run`);
    return 0;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    error(redactLogText(`failed to mark issue blocked: ${message}`));
    return 1;
  }
}
function resolveGitHubToken(runtime, env) {
  return runtime.githubToken ? runtime.githubToken() : githubAppToken({
    env,
    fetch: runtime.fetch || fetch,
    permissionProfile: "runner-status-write"
  });
}
async function markIssueBlocked(options) {
  if (options.dryRun) return;
  await removeIssueLabelIfPresent(options, gitVibeLabels.inProgress.name);
  await removeIssueLabelIfPresent(options, gitVibeLabels.approved.name);
  await addIssueLabel(options, gitVibeLabels.blocked.name);
}
async function removeIssueLabelIfPresent(options, label) {
  try {
    await options.client.request({
      method: "DELETE",
      path: `/repos/${options.owner}/${options.repo}/issues/${options.issueNumber}/labels/${encodeURIComponent(label)}`,
      token: options.token
    });
  } catch (caught) {
    if (!isNotFound(caught)) throw caught;
  }
}
async function addIssueLabel(options, label) {
  await options.client.request({
    body: { labels: [label] },
    method: "POST",
    path: `/repos/${options.owner}/${options.repo}/issues/${options.issueNumber}/labels`,
    token: options.token
  });
}
function requiredEnv2(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
function isTrue(value) {
  return value === "true" || value === "1";
}
function isNotFound(caught) {
  return caught instanceof Error && /\b404\b/.test(caught.message);
}
function isDirectRun(moduleUrl, entrypoint = process.argv[1]) {
  if (!moduleUrl) {
    return Boolean(entrypoint && /(?:^|[/\\])mark-blocked\.(?:c?js|ts)$/.test(entrypoint));
  }
  return Boolean(entrypoint && moduleUrl === pathToFileURL(resolve(entrypoint)).href);
}
if (isDirectRun("", process.argv[1])) {
  markBlocked().then((code) => {
    process.exit(code);
  });
}
export {
  isDirectRun,
  markBlocked,
  markIssueBlocked
};
