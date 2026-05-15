// @ts-nocheck
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { vi } from "vitest";
import { createGitVibeApp } from "../../src/app/server.ts";

export function createApp(options = {}) {
  return createGitVibeApp({
    client: options.client || createClient(),
    configuredRepository: options.configuredRepository || "",
    errorLog: options.errorLog || vi.fn(),
    githubToken: "token",
    log: options.log || vi.fn(),
    webhookSecret: "secret",
  });
}

export function createClient(options = {}) {
  let workflowDispatchAttempts = 0;
  return {
    graphql: vi.fn(async (query, _variables) => graphqlResponseFor(query, options)),
    request: vi.fn(async (request) => {
      if (request.method === "POST" && request.path.includes("/actions/workflows/")) {
        workflowDispatchAttempts += 1;
        return workflowDispatchResponse(options, workflowDispatchAttempts);
      }
      return requestResponseFor(request, options);
    }),
  };
}

function graphqlResponseFor(query, options) {
  const categories = options.categories || [{ id: "ideas", name: "Ideas", slug: "ideas" }];
  if (query.includes("GitVibeDiscussionCategories")) {
    return { repository: { discussionCategories: { nodes: categories }, id: "repo-id" } };
  }
  if (query.includes("GitVibeAddReaction")) {
    if (options.reactionError) throw options.reactionError;
    return { addReaction: { reaction: { content: "ROCKET" } } };
  }
  if (query.includes("GitVibeAddDiscussionComment")) {
    return { addDiscussionComment: { comment: { id: "comment-id", url: "comment-url" } } };
  }
  if (query.includes("GitVibeDiscussionComments")) {
    return { node: { comments: { nodes: options.discussionComments || [] } } };
  }
  if (query.includes("GitVibeDiscussionLabels")) {
    return {
      node: { labels: { nodes: (options.discussionLabels || []).map((name) => ({ name })) } },
    };
  }
  if (query.includes("GitVibeDeleteDiscussionComment")) {
    return { deleteDiscussionComment: { clientMutationId: null } };
  }
  if (query.includes("GitVibeAddDiscussionLabel")) {
    return { addLabelsToLabelable: { clientMutationId: null } };
  }
  if (query.includes("GitVibeRemoveDiscussionLabel")) {
    if (options.discussionLabelRemovalError) throw options.discussionLabelRemovalError;
    return { removeLabelsFromLabelable: { clientMutationId: null } };
  }
  if (query.includes("GitVibeDiscussionLabelId")) {
    return { repository: { label: { id: "resolved-label-node" } } };
  }
  return {
    createDiscussion: {
      discussion: {
        id: "discussion-id",
        number: 7,
        url: "https://github.com/example/repo/discussions/7",
      },
    },
  };
}

function requestResponseFor(request, options) {
  if (request.path.includes("/collaborators/")) {
    const permission = options.permission || { permission: "write" };
    if (permission instanceof Error) throw permission;
    return permission;
  }
  if (request.method === "GET" && request.path.includes("/comments?")) {
    if (options.commentsError) throw options.commentsError;
    return options.comments || [];
  }
  if (request.method === "GET" && request.path.includes("/actions/variables/")) {
    if (options.baseBranchVariableError) throw options.baseBranchVariableError;
    if (options.baseBranchVariable !== undefined) {
      return { name: "GITVIBE_BASE_BRANCH", value: options.baseBranchVariable };
    }
    throw new Error("GitHub API GET actions variable failed: 404");
  }
  if (request.method === "GET" && request.path === "/repos/example/repo") {
    return { default_branch: options.defaultBranch || "main" };
  }
  if (request.method === "GET" && request.path.includes("/pulls/")) {
    return { body: options.pullRequestBody || "" };
  }
  if (request.method === "POST" && request.path.endsWith("/labels")) {
    if (options.labelError) throw options.labelError;
    return {};
  }
  if (request.method === "POST" && request.path.includes("/issues/")) {
    if (request.path.includes("/comments") && options.issueCommentError) {
      throw options.issueCommentError;
    }
    return {};
  }
  if (request.method === "PATCH" && request.path.includes("/issues/")) {
    return {};
  }
  if (request.method === "DELETE" && request.path.includes("/labels/")) {
    if (options.labelRemovalError) throw options.labelRemovalError;
    return {};
  }
  if (request.method === "DELETE" && request.path.includes("/comments/")) {
    return {};
  }
  throw new Error(`unexpected request ${request.method} ${request.path}`);
}

function workflowDispatchResponse(options, workflowDispatchAttempts) {
  if (workflowDispatchAttempts <= (options.workflowDispatchErrorCount || 0)) {
    throw options.workflowDispatchError;
  }
  return (
    options.workflowDispatchResponse || {
      html_url: "https://github.com/example/repo/actions/runs/1",
      run_url: "https://api.github.com/repos/example/repo/actions/runs/1",
      workflow_run_id: 1,
    }
  );
}

export function featureIssue() {
  return {
    body: "### Request type\n\nFeature request\n\n### Background story\n\nNeed it.",
    html_url: "https://github.com/example/repo/issues/2",
    number: 2,
    title: "[Feature]: Add workflows",
    user: { login: "octocat" },
  };
}

export const repositoryPayload = () => ({ name: "repo", owner: { login: "example" } });

const requests = (client) => client.request.mock.calls.map(([request]) => request);

export function requestBodies(client, method, pathPart) {
  return requests(client)
    .filter((request) => request.method === method && request.path.includes(pathPart))
    .map((request) => request.body);
}

export const requestPaths = (client, method) =>
  requests(client)
    .filter((request) => request.method === method)
    .map((request) => request.path);

export const workflowDispatches = (client) =>
  requests(client)
    .filter((request) => request.path.includes("/actions/workflows/"))
    .map((request) => request.body);

export function sourceComments(client) {
  return workflowDispatches(client)
    .map((dispatch) => dispatch.inputs["source-comment"])
    .filter(Boolean)
    .map((value) => JSON.parse(value));
}

export const sourceCommentKinds = (client) => sourceComments(client).map((comment) => comment.kind);

export function reactionVariables(client) {
  return client.graphql.mock.calls
    .filter(([query]) => query.includes("GitVibeAddReaction"))
    .map(([, variables]) => variables);
}

export function discussionCommentBodies(client) {
  return client.graphql.mock.calls
    .filter(([query]) => query.includes("GitVibeAddDiscussionComment"))
    .map(([, variables]) => variables.body);
}

export function discussionLabelRemovals(client) {
  return client.graphql.mock.calls
    .filter(([query]) => query.includes("GitVibeRemoveDiscussionLabel"))
    .map(([, variables]) => variables);
}

export function discussionLabelAdds(client) {
  return client.graphql.mock.calls
    .filter(([query]) => query.includes("GitVibeAddDiscussionLabel"))
    .map(([, variables]) => variables);
}

export const signature = (body) =>
  `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;

export async function withHttpServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  try {
    return await run(url);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

export async function requestJson(baseUrl, method, path, body = "", headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    body: method === "GET" ? undefined : body,
    headers,
    method,
  });
  return { body: await response.json(), status: response.status };
}

export async function requestSignedWebhook(app, payload, event) {
  return withHttpServer(app.handleRequest, (url) => {
    const body = JSON.stringify(payload);
    return requestJson(url, "POST", "/webhooks", body, {
      "x-github-event": event,
      "x-hub-signature-256": signature(body),
    });
  });
}
