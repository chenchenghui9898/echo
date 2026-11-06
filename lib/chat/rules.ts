export function validateChatContent(value: unknown, maxLength: number) {
  const content = typeof value === "string" ? value.trim() : "";
  if (!content) return { content: "", error: "消息不能为空。" };
  if (content.length > maxLength) {
    return { content, error: `单条消息不能超过 ${maxLength} 个字符。` };
  }
  return { content, error: null };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateClientRequestId(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return { clientRequestId: undefined, error: null };
  }
  const clientRequestId = typeof value === "string" ? value.trim() : "";
  if (!UUID_PATTERN.test(clientRequestId)) {
    return { clientRequestId: undefined, error: "消息请求标识无效。" };
  }
  return { clientRequestId, error: null };
}

export function canGroupChatMessages(
  previous: { senderId: string; createdAt: string } | undefined,
  current: { senderId: string; createdAt: string },
  windowMs = 5 * 60 * 1000,
) {
  if (!previous || previous.senderId !== current.senderId) return false;
  const interval = new Date(current.createdAt).getTime() - new Date(previous.createdAt).getTime();
  return interval >= 0 && interval < windowMs;
}
import {
  CHAT_REPORT_REASONS,
  STYLE_REASON_CODES,
  type ChatReportReason,
  type StyleReasonCode,
} from "../ai-lab/types.ts";


export function validateChatReport(value: unknown, noteValue: unknown) {
  const reason = typeof value === "string" && CHAT_REPORT_REASONS.includes(value as ChatReportReason)
    ? value as ChatReportReason
    : null;
  const note = typeof noteValue === "string" ? noteValue.trim() : "";
  if (!reason) return { reason, note, error: "请选择举报原因。" };
  if (note.length > 500) return { reason, note, error: "补充说明不能超过 500 个字符。" };
  return { reason, note, error: null };
}

export function validateChatStyleFeedback(input: {
  type: unknown;
  reasons: unknown;
  note: unknown;
}) {
  const type: "like" | "dislike" | null =
    input.type === "like" || input.type === "dislike" ? input.type : null;
  const reasons = Array.isArray(input.reasons)
    ? [...new Set(input.reasons)].filter(
        (item): item is StyleReasonCode =>
          typeof item === "string" && STYLE_REASON_CODES.includes(item as StyleReasonCode),
      )
    : [];
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (!type) return { type, reasons, note, error: "请选择反馈类型。" };
  if (type === "dislike" && reasons.length === 0 && !note) {
    return { type, reasons, note, error: "请选择至少一个原因，或填写补充说明。" };
  }
  if (note.length > 500) return { type, reasons, note, error: "补充说明不能超过 500 个字符。" };
  return { type, reasons: type === "like" ? [] : reasons, note, error: null };
}
