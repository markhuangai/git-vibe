import { GitHubClient, splitRepository } from "./github.js";
import type { ContextPacket, JsonObject, TimelineItem } from "./types.js";

interface IssueResponse extends JsonObject {
  author_association?: string;
  body?: string;
  created_at?: string;
  html_url?: string;
  number?: number;
  reactions?: JsonObject;
  title?: string;
  user?: { login?: string };
}

interface CommentResponse extends IssueResponse {
  id?: number;
}

export async function buildIssueContext(options: {
  client: GitHubClient;
  issueNumber: string;
  repository: string;
  token: string;
  type?: "issue" | "pull-request";
}): Promise<ContextPacket> {
  const { owner, repo } = splitRepository(options.repository);
  const issue = await options.client.request<IssueResponse>({
    method: "GET",
    path: `/repos/${owner}/${repo}/issues/${options.issueNumber}`,
    token: options.token,
  });
  const comments = await options.client.request<CommentResponse[]>({
    method: "GET",
    path: `/repos/${owner}/${repo}/issues/${options.issueNumber}/comments?per_page=100`,
    token: options.token,
  });
  const timeline = [
    toTimelineItem("body", `issue-${options.issueNumber}`, issue),
    ...comments.map((comment) => toTimelineItem("comment", String(comment.id || ""), comment)),
  ].sort(compareTimelineItems);

  return {
    artifact: {
      body: issue.body || "",
      number: String(issue.number || options.issueNumber),
      title: issue.title || "",
      type: options.type || "issue",
      url: issue.html_url || "",
    },
    generatedAt: new Date().toISOString(),
    repository: options.repository,
    timeline,
  };
}

export async function buildDiscussionContext(options: {
  client: GitHubClient;
  discussionNumber: string;
  repository: string;
  token: string;
}): Promise<ContextPacket> {
  const { owner, repo } = splitRepository(options.repository);
  const data = await options.client.graphql<DiscussionQueryResult>(
    discussionQuery,
    { name: repo, number: Number(options.discussionNumber), owner },
    options.token,
  );
  const discussion = data.repository.discussion;
  const comments = discussion.comments.nodes.flatMap((comment) => [
    discussionNodeToTimelineItem("comment", comment.id, comment),
    ...(comment.replies?.nodes || []).map((reply) =>
      discussionNodeToTimelineItem("reply", reply.id, reply, comment.id),
    ),
  ]);

  return {
    artifact: {
      body: discussion.body || "",
      id: discussion.id,
      number: options.discussionNumber,
      title: discussion.title || "",
      type: "discussion",
      url: discussion.url || "",
    },
    generatedAt: new Date().toISOString(),
    repository: options.repository,
    timeline: [
      discussionNodeToTimelineItem("body", `discussion-${options.discussionNumber}`, discussion),
      ...comments,
    ].sort(compareTimelineItems),
  };
}

function toTimelineItem(kind: string, id: string, item: IssueResponse): TimelineItem {
  return {
    author: item.user?.login || "<unknown>",
    authorAssociation: item.author_association,
    body: item.body || "",
    createdAt: item.created_at || "",
    id,
    kind,
    reactions: item.reactions,
    url: item.html_url || "",
  };
}

function discussionNodeToTimelineItem(
  kind: string,
  id: string,
  item: DiscussionNode,
  parentId?: string,
): TimelineItem {
  return {
    author: item.author?.login || "<unknown>",
    body: item.body || "",
    createdAt: item.createdAt || "",
    id,
    kind,
    parentId,
    reactions: {},
    url: item.url || "",
  };
}

function compareTimelineItems(left: TimelineItem, right: TimelineItem): number {
  return left.createdAt.localeCompare(right.createdAt);
}

interface DiscussionNode {
  author?: { login?: string };
  body?: string;
  createdAt?: string;
  id: string;
  replies?: { nodes: DiscussionNode[] };
  title?: string;
  url?: string;
}

interface DiscussionQueryResult {
  repository: {
    discussion: DiscussionNode & {
      comments: { nodes: DiscussionNode[] };
    };
  };
}

const discussionQuery = `
  query GitVibeDiscussion($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      discussion(number: $number) {
        id
        title
        body
        createdAt
        url
        author { login }
        comments(first: 100) {
          nodes {
            id
            body
            createdAt
            url
            author { login }
            replies(first: 100) {
              nodes {
                id
                body
                createdAt
                url
                author { login }
                replies(first: 0) { nodes { id } }
              }
            }
          }
        }
      }
    }
  }
`;
