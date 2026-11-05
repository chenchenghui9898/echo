import assert from "node:assert/strict";
import test from "node:test";

import { getChatAiConfig } from "../lib/chat/ai-config.ts";
import { CHAT_AI_PERSONAS } from "../lib/chat/ai-personas.ts";
import { inferChatTopics, planChatAiParticipation } from "../lib/chat/ai-planner.ts";
import { CHAT_AI_EVALUATION_CASES } from "./chat-ai-cases.ts";

function sequence(values) {
  let index = 0;
  return () => values[index++ % values.length];
}

function message(overrides = {}) {
  return {
    id: "message-1", roomId: "echo-public-mood", senderId: "human-1", senderType: "human",
    senderName: "测试用户", content: "下班以后想吃冰棍", createdAt: "2026-11-03T10:00:00.000Z",
    updatedAt: "2026-11-03T10:00:00.000Z", status: "normal", ...overrides,
  };
}

test("至少六个群友具有完整且不同的参与配置", () => {
  assert.ok(CHAT_AI_PERSONAS.length >= 6);
  assert.equal(new Set(CHAT_AI_PERSONAS.map((persona) => persona.id)).size, CHAT_AI_PERSONAS.length);
  assert.ok(new Set(CHAT_AI_PERSONAS.map((persona) => persona.activity)).size >= 3);
  for (const persona of CHAT_AI_PERSONAS) {
    assert.ok(persona.background && persona.languageHabits && persona.dislikedExpressions);
    assert.ok(persona.topics.length > 0 && persona.enabled);
    assert.ok(persona.hourlyMessageLimit > 0 && persona.dailyMessageLimit >= persona.hourlyMessageLimit);
    assert.ok(persona.minimumIntervalMs > 0);
  }
});

test("十组语言质量样例覆盖要求的群聊情境", () => {
  assert.equal(CHAT_AI_EVALUATION_CASES.length, 10);
  assert.deepEqual(
    CHAT_AI_EVALUATION_CASES.map((item) => item.label),
    ["日常闲聊", "开心", "烦躁", "吐槽", "疑问", "不同意见", "无意义短句", "天气", "吃喝", "普通生活"],
  );
  for (const item of CHAT_AI_EVALUATION_CASES) assert.ok(inferChatTopics(item.content).length > 0);
});

test("普通消息可以不回复，也不会安排超过两个群友", () => {
  const config = { ...getChatAiConfig(), replyProbability: 0.78, secondPersonaProbability: 1 };
  const none = planChatAiParticipation({
    trigger: message(), parent: null, recentMessages: [], config, random: sequence([0.99]),
  });
  assert.equal(none.length, 0);
  const two = planChatAiParticipation({
    trigger: message(), parent: null, recentMessages: [], config, random: sequence([0.1, 0.2, 0.3, 0.1, 0.7]),
  });
  assert.equal(two.length, 2);
  assert.notEqual(two[0].persona.id, two[1].persona.id);
});

test("用户明确回复 AI 时同一人格获得优先权", () => {
  const parent = message({
    id: "ai-1", senderId: "ai:xiaolin", senderType: "ai", senderName: "小林",
    personaId: "xiaolin", personaVersion: 1, content: "绿色包装那个？",
  });
  const trigger = message({ id: "human-reply", content: "对，就是五毛钱一根的。", replyToMessageId: parent.id });
  const plan = planChatAiParticipation({
    trigger, parent, recentMessages: [parent, trigger],
    config: { ...getChatAiConfig(), directReplyProbability: 1 }, random: sequence([0, 0.5]),
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].persona.id, "xiaolin");
});

test("最近 AI 已较密集时显著降低继续参与概率", () => {
  const recent = [0, 1, 2].map((index) => message({
    id: `ai-${index}`, senderId: `ai-${index}`, senderType: "ai", personaId: "xiaolin",
  }));
  const plan = planChatAiParticipation({
    trigger: message(), parent: null, recentMessages: recent,
    config: { ...getChatAiConfig(), replyProbability: 0.8 }, random: sequence([0.3]),
  });
  assert.equal(plan.length, 0);
});

test("开发时间缩放只压缩延迟，不改变正式延迟配置", () => {
  const now = new Date("2026-11-03T10:00:00.000Z");
  const plan = planChatAiParticipation({
    trigger: message(), parent: null, recentMessages: [], now,
    config: {
      ...getChatAiConfig(), replyProbability: 1, secondPersonaProbability: 0,
      firstDelayMinMs: 10_000, firstDelayMaxMs: 10_000, timeScale: 0.01,
    },
    random: sequence([0, 0.2, 0.5, 0.9]),
  });
  assert.equal(new Date(plan[0].scheduledAt).getTime() - now.getTime(), 100);
});

test("人格达到小时上限时不会继续被选中", () => {
  const config = { ...getChatAiConfig(), replyProbability: 1, secondPersonaProbability: 0 };
  const personaActivity = Object.fromEntries(CHAT_AI_PERSONAS.map((persona) => [persona.id, {
    hourlyCount: persona.hourlyMessageLimit,
    dailyCount: persona.hourlyMessageLimit,
    lastMessageAt: "2026-11-03T09:59:00.000Z",
  }]));
  const plan = planChatAiParticipation({
    trigger: message(), parent: null, recentMessages: [], config,
    now: new Date("2026-11-03T10:00:00.000Z"), random: sequence([0]),
    activitySnapshot: {
      recent10AiCount: 0, recent30AiShare: 0, consecutiveAiCount: 0, personaActivity,
    },
  });
  assert.equal(plan.length, 0);
});

test("最近三十条 AI 占比过高时显著降低普通参与概率", () => {
  const config = { ...getChatAiConfig(), replyProbability: 1, secondPersonaProbability: 1 };
  const plan = planChatAiParticipation({
    trigger: message(), parent: null, recentMessages: [], config, random: sequence([0.2]),
    activitySnapshot: {
      recent10AiCount: 5, recent30AiShare: 0.5, consecutiveAiCount: 0, personaActivity: {},
    },
  });
  assert.equal(plan.length, 0);
});
