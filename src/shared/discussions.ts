import { GitHubClient, splitRepository } from "./github.js";

export interface CreatedDiscussion {
  id: string;
  number: number;
  url: string;
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
}): Promise<void> {
  await options.client.graphql(
    addDiscussionCommentMutation,
    {
      body: options.body,
      discussionId: options.discussionId,
      replyToId: options.replyToId || null,
    },
    options.token,
  );
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
