export const sourceDiscussionMarker = "<!-- git-vibe:source-discussion";

export function implementationIssueBody(options: {
  discussionNumber: string;
  discussionUrl: string;
  issueBody: string;
}): string {
  return [
    options.issueBody,
    "",
    `Source discussion: ${options.discussionUrl}`,
    "",
    `${sourceDiscussionMarker} number=${options.discussionNumber} url=${options.discussionUrl} -->`,
  ].join("\n");
}
