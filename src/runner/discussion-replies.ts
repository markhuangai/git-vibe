import type { ContextPacket, RunnerOptions } from "../shared/types.js";

export function discussionReplyToId(
  runner: RunnerOptions,
  context: ContextPacket,
): string | undefined {
  const source = runner.sourceComment;
  if (source?.kind !== "discussion-comment" || !source.nodeId) return undefined;

  const sourceItem = context.timeline.find((item) => item.id === source.nodeId);
  return sourceItem?.parentId || source.nodeId;
}
