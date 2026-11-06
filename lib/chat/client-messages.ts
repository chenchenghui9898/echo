import type { ChatMessageView } from "@/lib/ai-lab/types";

export type MessageDeliveryState = "sending" | "failed";

export type DisplayChatMessage = ChatMessageView & {
  deliveryState?: MessageDeliveryState;
  deliveryError?: string;
  clientOrder?: number;
};

export function isOptimisticMessage(message: DisplayChatMessage) {
  return Boolean(message.deliveryState);
}

export function mergeDisplayMessages(
  current: DisplayChatMessage[],
  incoming: DisplayChatMessage[],
) {
  const confirmed = new Map<string, DisplayChatMessage>();
  const optimistic = new Map<string, DisplayChatMessage>();

  for (const message of current) {
    if (isOptimisticMessage(message) && message.clientRequestId) {
      optimistic.set(message.clientRequestId, message);
    } else {
      confirmed.set(message.id, message);
    }
  }

  for (const message of incoming) {
    if (isOptimisticMessage(message) && message.clientRequestId) {
      optimistic.set(message.clientRequestId, message);
      continue;
    }
    confirmed.set(message.id, message);
    if (message.clientRequestId) optimistic.delete(message.clientRequestId);
  }

  const orderedConfirmed = [...confirmed.values()].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const orderedOptimistic = [...optimistic.values()].sort(
    (left, right) => (left.clientOrder ?? 0) - (right.clientOrder ?? 0),
  );
  return [...orderedConfirmed, ...orderedOptimistic];
}
