export type ContentReaction = "agree" | "disagree" | null;

export function toggleContentReaction(
  current: ContentReaction,
  clicked: Exclude<ContentReaction, null>,
): ContentReaction {
  return current === clicked ? null : clicked;
}

export function shouldGenerateAgreementFollowUp(input: {
  previousReaction: ContentReaction;
  nextReaction: ContentReaction;
  hasExistingFollowUp: boolean;
}) {
  return (
    input.nextReaction === "agree" &&
    input.previousReaction !== "agree" &&
    !input.hasExistingFollowUp
  );
}

export function isReplyRateLimited(
  latestReplyAt: string | undefined,
  nowMs = Date.now(),
  cooldownMs = 3_000,
) {
  if (!latestReplyAt) return false;
  return nowMs - new Date(latestReplyAt).getTime() < cooldownMs;
}

export function hasStyleFeedbackContent(reasons: readonly string[], note: string) {
  return reasons.length > 0 || Boolean(note.trim());
}
