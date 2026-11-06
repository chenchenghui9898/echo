import assert from "node:assert/strict";
import test from "node:test";

import {
  canGroupChatMessages,
  validateChatContent,
  validateClientRequestId,
  validateChatReport,
  validateChatStyleFeedback,
} from "../lib/chat/rules.ts";
import { mergeDisplayMessages } from "../lib/chat/client-messages.ts";
import {
  getEchoDataBackend,
  getSupabaseAdminConfig,
  getSupabasePublicConfig,
  hasSupabaseAdminConfig,
} from "../lib/supabase/config.ts";

test("消息正文会去除首尾空白并保留内部换行", () => {
  const result = validateChatContent("  第一行\n第二行  ", 1000);
  assert.equal(result.error, null);
  assert.equal(result.content, "第一行\n第二行");
});

test("空消息和超长消息会被拒绝", () => {
  assert.equal(validateChatContent(" \n ", 1000).error, "消息不能为空。");
  assert.equal(validateChatContent("一".repeat(11), 10).error, "单条消息不能超过 10 个字符。");
});

test("客户端请求 ID 只接受 UUID，也允许旧客户端不传", () => {
  assert.equal(validateClientRequestId(undefined).error, null);
  assert.equal(
    validateClientRequestId("d9a5cd23-1be4-4a7d-8a2c-cc0f2fc57c98").clientRequestId,
    "d9a5cd23-1be4-4a7d-8a2c-cc0f2fc57c98",
  );
  assert.ok(validateClientRequestId("not-a-uuid").error);
});

test("服务端消息按 createdAt 和 id 排序，待发送消息始终位于底部", () => {
  const base = {
    roomId: "echo-public-mood", senderId: "u1", senderType: "human",
    senderName: "用户", content: "", updatedAt: "2026-11-05T00:00:00Z",
    status: "normal", replyTo: null, styleFeedback: null,
  };
  const merged = mergeDisplayMessages([], [
    { ...base, id: "b", content: "second", createdAt: "2026-11-05T00:00:01Z" },
    { ...base, id: "optimistic:r1", clientRequestId: "r1", content: "pending", createdAt: "2026-01-01T00:00:00Z", deliveryState: "sending", clientOrder: 1 },
    { ...base, id: "a", content: "first", createdAt: "2026-11-05T00:00:00Z" },
  ]);
  assert.deepEqual(merged.map((message) => message.content), ["first", "second", "pending"]);
});

test("轮询或发送响应都用 clientRequestId 替换临时消息且不会重复", () => {
  const optimistic = {
    id: "optimistic:r1", clientRequestId: "r1", roomId: "echo-public-mood",
    senderId: "u1", senderType: "human", senderName: "用户", content: "测试",
    createdAt: "2026-11-05T00:00:00Z", updatedAt: "2026-11-05T00:00:00Z",
    status: "normal", replyTo: null, styleFeedback: null, deliveryState: "sending",
    clientOrder: 1,
  };
  const confirmed = {
    ...optimistic, id: "server-1", createdAt: "2026-11-05T00:00:02Z",
    updatedAt: "2026-11-05T00:00:02Z", deliveryState: undefined, clientOrder: undefined,
  };
  const afterPoll = mergeDisplayMessages([optimistic], [confirmed]);
  const afterResponse = mergeDisplayMessages(afterPoll, [confirmed]);
  assert.equal(afterResponse.length, 1);
  assert.equal(afterResponse[0].id, "server-1");
  assert.equal(afterResponse[0].deliveryState, undefined);
});

test("发送失败会保留临时消息，使用同一请求 ID 重试成功后才替换", () => {
  const failed = {
    id: "optimistic:r2", clientRequestId: "r2", roomId: "echo-public-mood",
    senderId: "u1", senderType: "human", senderName: "用户", content: "不要丢失",
    createdAt: "2026-11-05T00:00:00Z", updatedAt: "2026-11-05T00:00:00Z",
    status: "normal", replyTo: null, styleFeedback: null, deliveryState: "failed",
    deliveryError: "发送失败", clientOrder: 2,
  };
  const unrelated = {
    ...failed, id: "server-other", clientRequestId: "other", content: "其他用户消息",
    createdAt: "2026-11-05T00:00:01Z", deliveryState: undefined,
    deliveryError: undefined, clientOrder: undefined,
  };
  const beforeRetry = mergeDisplayMessages([failed], [unrelated]);
  assert.equal(beforeRetry.at(-1)?.id, "optimistic:r2");
  assert.equal(beforeRetry.at(-1)?.deliveryState, "failed");

  const confirmed = {
    ...failed, id: "server-r2", createdAt: "2026-11-05T00:00:02Z",
    updatedAt: "2026-11-05T00:00:02Z", deliveryState: undefined,
    deliveryError: undefined, clientOrder: undefined,
  };
  const afterRetry = mergeDisplayMessages(beforeRetry, [confirmed]);
  assert.equal(afterRetry.filter((message) => message.clientRequestId === "r2").length, 1);
  assert.equal(afterRetry.find((message) => message.clientRequestId === "r2")?.id, "server-r2");
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

test("群聊数据源默认使用 JSON，并且只接受显式支持的配置", () => {
  assert.equal(getEchoDataBackend({}), "json");
  assert.equal(getEchoDataBackend({ ECHO_DATA_BACKEND: "supabase" }), "supabase");
  assert.throws(
    () => getEchoDataBackend({ ECHO_DATA_BACKEND: "unknown" }),
    /INVALID_ECHO_DATA_BACKEND/,
  );
});

test("Supabase 数据源缺少公开配置时会明确失败", () => {
  assert.throws(() => getSupabasePublicConfig({}), /SUPABASE_PUBLIC_CONFIG_MISSING/);
  assert.deepEqual(
    getSupabasePublicConfig({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable-test",
    }),
    { url: "https://example.supabase.co", publishableKey: "publishable-test" },
  );
});

test("Supabase Worker 只接受服务端 Secret Key，并兼容旧 Service Role Key", () => {
  const publicOnly = {
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable-test",
  };
  assert.equal(hasSupabaseAdminConfig(publicOnly), false);
  assert.throws(() => getSupabaseAdminConfig(publicOnly), /SUPABASE_ADMIN_CONFIG_MISSING/);
  assert.deepEqual(
    getSupabaseAdminConfig({ ...publicOnly, SUPABASE_SECRET_KEY: "secret-test" }),
    { url: "https://example.supabase.co", secretKey: "secret-test" },
  );
  assert.equal(
    hasSupabaseAdminConfig({ ...publicOnly, SUPABASE_SERVICE_ROLE_KEY: "legacy-test" }),
    true,
  );
});
