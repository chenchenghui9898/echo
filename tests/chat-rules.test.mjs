import assert from "node:assert/strict";
import test from "node:test";

import {
  canGroupChatMessages,
  validateChatContent,
  validateChatReport,
  validateChatStyleFeedback,
} from "../lib/chat/rules.ts";

test("消息正文会去除首尾空白并保留内部换行", () => {
  const result = validateChatContent("  第一行\n第二行  ", 1000);
  assert.equal(result.error, null);
  assert.equal(result.content, "第一行\n第二行");
});

test("空消息和超长消息会被拒绝", () => {
  assert.equal(validateChatContent(" \n ", 1000).error, "消息不能为空。");
  assert.equal(validateChatContent("一".repeat(11), 10).error, "单条消息不能超过 10 个字符。");
});

test("只有同一发送者在时间窗口内的连续消息可以合并展示", () => {
  const first = { senderId: "user-a", createdAt: "2026-11-03T10:00:00.000Z" };
  assert.equal(canGroupChatMessages(first, { senderId: "user-a", createdAt: "2026-11-03T10:04:59.000Z" }), true);
  assert.equal(canGroupChatMessages(first, { senderId: "user-a", createdAt: "2026-11-03T10:05:00.000Z" }), false);
  assert.equal(canGroupChatMessages(first, { senderId: "user-b", createdAt: "2026-11-03T10:00:10.000Z" }), false);
});

test("举报原因和补充说明会经过服务端校验", () => {
  assert.equal(validateChatReport("attack", "具体说明").error, null);
  assert.equal(validateChatReport("unknown", "").error, "请选择举报原因。");
  assert.ok(validateChatReport("other", "一".repeat(501)).error);
});

test("AI 风格负反馈需要原因或具体说明，正反馈会清空负面原因", () => {
  const invalid = validateChatStyleFeedback({ type: "dislike", reasons: [], note: "" });
  assert.ok(invalid.error);
  const dislike = validateChatStyleFeedback({
    type: "dislike", reasons: ["ai_heavy", "ai_heavy", "vague"], note: "太像模板",
  });
  assert.equal(dislike.error, null);
  assert.deepEqual(dislike.reasons, ["ai_heavy", "vague"]);
  const like = validateChatStyleFeedback({ type: "like", reasons: ["vague"], note: "" });
  assert.deepEqual(like.reasons, []);
});
