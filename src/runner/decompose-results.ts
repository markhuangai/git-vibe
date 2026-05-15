import { deleteDiscussionComment } from "../shared/discussions.js";
import { parseDecomposeResultMarker } from "./result-comments.js";
import type { GitHubClient } from "../shared/github.js";
import type { ContextPacket, RunnerOptions } from "../shared/types.js";
import type { StageLogger } from "./logging.js";

export async function cleanupPriorDecomposeResultComments(options: {
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  runner: RunnerOptions;
}): Promise<void> {
  if (options.runner.stage !== "decompose" || options.context.artifact.type !== "discussion") {
    return;
  }

  const ids = priorDecomposeResultCommentIds(options.context);
  await Promise.all(ids.map((commentId) => deletePriorDecomposeResultComment(options, commentId)));
}

function priorDecomposeResultCommentIds(context: ContextPacket): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of context.timeline) {
    const marker = parseDecomposeResultMarker(item.body);
    if (!marker || marker.number !== context.artifact.number || seen.has(item.id)) continue;
    seen.add(item.id);
    ids.push(item.id);
  }
  return ids;
}

async function deletePriorDecomposeResultComment(
  options: {
    client: GitHubClient;
    context: ContextPacket;
    logger: StageLogger;
    runner: RunnerOptions;
  },
  commentId: string,
): Promise<void> {
  try {
    await deleteDiscussionComment({
      client: options.client,
      commentId,
      token: options.runner.token,
    });
    options.logger.event("github.decompose_result.delete.done", {
      discussion: options.context.artifact.number,
      surface: "discussion-comment",
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) return;
    options.logger.event("github.decompose_result.delete.failed", {
      discussion: options.context.artifact.number,
      error: error instanceof Error ? error.message : String(error),
      surface: "discussion-comment",
    });
    throw error;
  }
}
