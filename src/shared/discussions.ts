import { GitHubClient, splitRepository } from "./github.js";

export interface CreatedDiscussion {
  id: string;
  number: number;
  url: string;
}

export interface CreatedDiscussionComment {
  id: string;
  url: string;
}

export interface DiscussionCommentNode {
  body: string;
  id: string;
  replies?: DiscussionCommentConnection;
  url: string;
}

export interface DiscussionCommentConnection {
  nodes: DiscussionCommentNode[];
  pageInfo?: PageInfo;
}

export interface DiscussionLabelNode {
  name: string;
}

interface PageInfo {
  endCursor?: string | null;
  hasNextPage?: boolean;
}

export interface DiscussionSetupCheck {
  categoryName: string;
  categorySlug: string;
  matchedConfiguredCategory: boolean;
  repository: string;
}

export async function createRepositoryDiscussion(options: {
  body: string;
  categoryName: string;
  client: GitHubClient;
  repository: string;
  title: string;
  token: string;
}): Promise<CreatedDiscussion> {
  const category = await discussionCategoryFor(options);
  const result = await options.client.graphql<CreateDiscussionResult>(
    createDiscussionMutation,
    {
      body: options.body,
      categoryId: category.id,
      repositoryId: category.repositoryId,
      title: options.title,
    },
    options.token,
  );
  const discussion = result.createDiscussion.discussion;
  return { id: discussion.id, number: discussion.number, url: discussion.url };
}

export async function checkRepositoryDiscussions(options: {
  categoryName: string;
  client: GitHubClient;
  repository: string;
  token: string;
}): Promise<DiscussionSetupCheck> {
  const category = await discussionCategoryFor(options);
  return {
    categoryName: category.name,
    categorySlug: category.slug,
    matchedConfiguredCategory: matchesCategory(category, options.categoryName),
    repository: options.repository,
  };
}

export async function addDiscussionComment(options: {
  body: string;
  client: GitHubClient;
  discussionId: string;
  replyToId?: string;
  token: string;
}): Promise<CreatedDiscussionComment> {
  const result = await options.client.graphql<AddDiscussionCommentResult>(
    addDiscussionCommentMutation,
    {
      body: options.body,
      discussionId: options.discussionId,
      replyToId: options.replyToId || null,
    },
    options.token,
  );
  const comment = result.addDiscussionComment.comment;
  return { id: comment.id, url: comment.url };
}

export async function discussionComments(options: {
  client: GitHubClient;
  discussionId: string;
  token: string;
}): Promise<DiscussionCommentNode[]> {
  const comments = await paginatedDiscussionComments(options);
  return comments.flatMap((comment) => [comment, ...(comment.replies?.nodes || [])]);
}

export async function deleteDiscussionComment(options: {
  client: GitHubClient;
  commentId: string;
  token: string;
}): Promise<void> {
  await options.client.graphql(
    deleteDiscussionCommentMutation,
    { id: options.commentId },
    options.token,
  );
}

export async function addDiscussionLabel(options: {
  client: GitHubClient;
  discussionId: string;
  label: string;
  labelId?: string;
  repository: string;
  token: string;
}): Promise<void> {
  const labelId = options.labelId || (await discussionLabelId(options));
  await options.client.graphql(
    addDiscussionLabelMutation,
    {
      discussionId: options.discussionId,
      labelIds: [labelId],
    },
    options.token,
  );
}

export async function removeDiscussionLabel(options: {
  client: GitHubClient;
  discussionId: string;
  label: string;
  labelId?: string;
  repository: string;
  token: string;
}): Promise<void> {
  const labelId = options.labelId || (await discussionLabelId(options));
  await options.client.graphql(
    removeDiscussionLabelMutation,
    {
      discussionId: options.discussionId,
      labelIds: [labelId],
    },
    options.token,
  );
}

export async function discussionLabels(options: {
  client: GitHubClient;
  discussionId: string;
  token: string;
}): Promise<string[]> {
  const labels: DiscussionLabelNode[] = [];
  let after: string | null = null;
  do {
    const result = await options.client.graphql<DiscussionLabelsResult>(
      discussionLabelsQuery,
      { discussionId: options.discussionId, labelsAfter: after },
      options.token,
    );
    const connection = result.node?.labels;
    labels.push(...(connection?.nodes || []));
    after = nextPageCursor(connection?.pageInfo);
  } while (after);

  return labels.map((label) => label.name.trim()).filter(Boolean);
}

export async function closeDiscussion(options: {
  client: GitHubClient;
  discussionId: string;
  token: string;
}): Promise<void> {
  await options.client.graphql(
    closeDiscussionMutation,
    { discussionId: options.discussionId },
    options.token,
  );
}

async function discussionLabelId(options: {
  client: GitHubClient;
  label: string;
  repository: string;
  token: string;
}): Promise<string> {
  const { owner, repo } = splitRepository(options.repository);
  const data = await options.client.graphql<DiscussionLabelIdResult>(
    discussionLabelIdQuery,
    { label: options.label, name: repo, owner },
    options.token,
  );
  const labelId = data.repository?.label?.id;
  if (!labelId) {
    throw new Error(`GitHub label ${options.label} was not found in ${options.repository}`);
  }
  return labelId;
}

async function discussionCategoryFor(options: {
  categoryName: string;
  client: GitHubClient;
  repository: string;
  token: string;
}): Promise<DiscussionCategory & { repositoryId: string }> {
  const { owner, repo } = splitRepository(options.repository);
  const data = await options.client.graphql<DiscussionCategoriesResult>(
    discussionCategoriesQuery,
    { name: repo, owner },
    options.token,
  );
  const repository = data.repository;
  const categories = repository.discussionCategories.nodes;
  const category = chooseCategory(categories, options.categoryName);
  if (!category) {
    throw new Error(
      `GitHub Discussions are not enabled or no categories exist for ${options.repository}`,
    );
  }

  return { ...category, repositoryId: repository.id };
}

function chooseCategory(
  categories: DiscussionCategory[],
  preferredName: string,
): DiscussionCategory | undefined {
  return categories.find((category) => matchesCategory(category, preferredName)) || categories[0];
}

function matchesCategory(category: DiscussionCategory, value: string): boolean {
  const normalized = normalizeCategory(value);
  return (
    normalizeCategory(category.name) === normalized ||
    normalizeCategory(category.slug) === normalized
  );
}

function normalizeCategory(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

async function paginatedDiscussionComments(options: {
  client: GitHubClient;
  discussionId: string;
  token: string;
}): Promise<DiscussionCommentNode[]> {
  const comments: DiscussionCommentNode[] = [];
  let after: string | null = null;
  do {
    const result = await options.client.graphql<DiscussionCommentsResult>(
      discussionCommentsQuery,
      { commentsAfter: after, discussionId: options.discussionId },
      options.token,
    );
    const connection = result.node?.comments;
    for (const comment of connection?.nodes || []) {
      const replies = await paginatedDiscussionReplies(options, comment);
      comments.push(
        replies.length || comment.replies ? { ...comment, replies: { nodes: replies } } : comment,
      );
    }
    after = nextPageCursor(connection?.pageInfo);
  } while (after);

  return comments;
}

async function paginatedDiscussionReplies(
  options: { client: GitHubClient; token: string },
  comment: DiscussionCommentNode,
): Promise<DiscussionCommentNode[]> {
  const replies = [...(comment.replies?.nodes || [])];
  let after = nextPageCursor(comment.replies?.pageInfo);
  while (after) {
    const result = await options.client.graphql<DiscussionCommentRepliesResult>(
      discussionCommentRepliesQuery,
      { commentId: comment.id, repliesAfter: after },
      options.token,
    );
    const connection = result.node?.replies;
    replies.push(...(connection?.nodes || []));
    after = nextPageCursor(connection?.pageInfo);
  }
  return replies;
}

function nextPageCursor(pageInfo: PageInfo | undefined): string | null {
  return pageInfo?.hasNextPage && pageInfo.endCursor ? pageInfo.endCursor : null;
}

interface DiscussionCategory {
  id: string;
  name: string;
  slug: string;
}

interface DiscussionCategoriesResult {
  repository: {
    discussionCategories: {
      nodes: DiscussionCategory[];
    };
    id: string;
  };
}

interface CreateDiscussionResult {
  createDiscussion: {
    discussion: CreatedDiscussion;
  };
}

interface AddDiscussionCommentResult {
  addDiscussionComment: {
    comment: CreatedDiscussionComment;
  };
}

interface DiscussionCommentsResult {
  node?: {
    comments?: DiscussionCommentConnection;
  } | null;
}

interface DiscussionLabelsResult {
  node?: {
    labels?: {
      nodes: DiscussionLabelNode[];
      pageInfo?: PageInfo;
    };
  } | null;
}

interface DiscussionCommentRepliesResult {
  node?: {
    replies?: DiscussionCommentConnection;
  } | null;
}

interface DiscussionLabelIdResult {
  repository?: {
    label?: {
      id?: string;
    } | null;
  } | null;
}

const discussionCategoriesQuery = `
  query GitVibeDiscussionCategories($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      id
      discussionCategories(first: 50) {
        nodes {
          id
          name
          slug
        }
      }
    }
  }
`;

const createDiscussionMutation = `
  mutation GitVibeCreateDiscussion(
    $body: String!
    $categoryId: ID!
    $repositoryId: ID!
    $title: String!
  ) {
    createDiscussion(
      input: {
        body: $body
        categoryId: $categoryId
        repositoryId: $repositoryId
        title: $title
      }
    ) {
      discussion {
        id
        number
        url
      }
    }
  }
`;

const addDiscussionCommentMutation = `
  mutation GitVibeAddDiscussionComment($body: String!, $discussionId: ID!, $replyToId: ID) {
    addDiscussionComment(input: { body: $body, discussionId: $discussionId, replyToId: $replyToId }) {
      comment {
        id
        url
      }
    }
  }
`;

const discussionCommentsQuery = `
  query GitVibeDiscussionComments($discussionId: ID!, $commentsAfter: String) {
    node(id: $discussionId) {
      ... on Discussion {
        comments(first: 100, after: $commentsAfter) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            body
            url
            replies(first: 100) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                body
                url
              }
            }
          }
        }
      }
    }
  }
`;

const discussionCommentRepliesQuery = `
  query GitVibeDiscussionCommentReplies($commentId: ID!, $repliesAfter: String) {
    node(id: $commentId) {
      ... on DiscussionComment {
        replies(first: 100, after: $repliesAfter) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            body
            url
          }
        }
      }
    }
  }
`;

const deleteDiscussionCommentMutation = `
  mutation GitVibeDeleteDiscussionComment($id: ID!) {
    deleteDiscussionComment(input: { id: $id }) {
      clientMutationId
    }
  }
`;

const discussionLabelsQuery = `
  query GitVibeDiscussionLabels($discussionId: ID!, $labelsAfter: String) {
    node(id: $discussionId) {
      ... on Discussion {
        labels(first: 100, after: $labelsAfter) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            name
          }
        }
      }
    }
  }
`;

const discussionLabelIdQuery = `
  query GitVibeDiscussionLabelId($label: String!, $name: String!, $owner: String!) {
    repository(owner: $owner, name: $name) {
      label(name: $label) {
        id
      }
    }
  }
`;

const addDiscussionLabelMutation = `
  mutation GitVibeAddDiscussionLabel($discussionId: ID!, $labelIds: [ID!]!) {
    addLabelsToLabelable(input: { labelableId: $discussionId, labelIds: $labelIds }) {
      clientMutationId
    }
  }
`;

const removeDiscussionLabelMutation = `
  mutation GitVibeRemoveDiscussionLabel($discussionId: ID!, $labelIds: [ID!]!) {
    removeLabelsFromLabelable(input: { labelableId: $discussionId, labelIds: $labelIds }) {
      clientMutationId
    }
  }
`;

const closeDiscussionMutation = `
  mutation GitVibeCloseDiscussion($discussionId: ID!) {
    closeDiscussion(input: { discussionId: $discussionId, reason: RESOLVED }) {
      discussion {
        id
      }
    }
  }
`;
