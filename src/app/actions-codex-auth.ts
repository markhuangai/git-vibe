import { updateRepositorySecret } from "../shared/repository-secrets.js";
import {
  canWriteBackCodexAuthForGitHubActionsJob,
  type InstallationTokenProvider,
} from "./github-app-auth.js";
import {
  defaultTrustedWorkflowRefPattern,
  verifyGitHubActionsJob,
  type GitHubActionsOidcVerifier,
} from "./actions-token.js";
import type { GitHubClient } from "../shared/github.js";

export interface ActionsCodexAuthWritebackRequestBody {
  oidcToken?: string;
  oidc_token?: string;
  value?: string;
}

export interface ActionsCodexAuthWritebackOptions {
  audience: string;
  body: string;
  client: GitHubClient;
  tokenProvider: InstallationTokenProvider;
  trustedWorkflowRefPattern?: RegExp;
  verifier: GitHubActionsOidcVerifier;
}

export interface ActionsCodexAuthWritebackResponse {
  updated: true;
}

const aiEnvBundleSecretName = "GITVIBE_AI_ENV_JSON";

export async function writeBackActionsCodexAuth(
  options: ActionsCodexAuthWritebackOptions,
): Promise<ActionsCodexAuthWritebackResponse> {
  const body = parseBody(options.body);
  const value = aiEnvBundleValue(body);
  const job = await verifyGitHubActionsJob({
    ...options,
    oidcToken: oidcToken(body),
    trustedWorkflowRefPattern:
      options.trustedWorkflowRefPattern || defaultTrustedWorkflowRefPattern,
  });
  if (
    !canWriteBackCodexAuthForGitHubActionsJob({
      checkRunName: job.checkRunName,
      jobWorkflowRef: job.claims.jobWorkflowRef,
    })
  ) {
    throw httpError("GitHub Actions job is not authorized to update Codex auth.", 403);
  }

  const token = await options.tokenProvider.tokenForRepository({
    owner: job.owner,
    profile: "server-secrets-write",
    repo: job.repo,
  });
  await updateRepositorySecret({
    client: options.client,
    name: aiEnvBundleSecretName,
    repository: job.claims.repository,
    token,
    value,
  });
  return { updated: true };
}

function parseBody(body: string): ActionsCodexAuthWritebackRequestBody {
  try {
    const parsed = JSON.parse(body || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw httpError("actions Codex auth request body must be a JSON object.", 400);
    }
    return parsed as ActionsCodexAuthWritebackRequestBody;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw httpError("actions Codex auth request body must be valid JSON.", 400);
    }
    throw error;
  }
}

function oidcToken(body: ActionsCodexAuthWritebackRequestBody): string {
  const value = body.oidcToken || body.oidc_token || "";
  if (!value.trim()) throw httpError("oidcToken is required.", 400);
  return value;
}

function aiEnvBundleValue(body: ActionsCodexAuthWritebackRequestBody): string {
  if (typeof body.value !== "string" || !body.value.trim()) {
    throw httpError("value is required.", 400);
  }
  try {
    const parsed = JSON.parse(body.value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw httpError("value must be a JSON object string.", 400);
    }
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode) throw error;
    throw httpError("value must be a valid JSON object string.", 400);
  }
  return body.value;
}

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
