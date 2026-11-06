import assert from "node:assert/strict";
import test from "node:test";

import { getChatAiConfig } from "../lib/chat/ai-config.ts";
import { CHAT_AI_PERSONAS } from "../lib/chat/ai-personas.ts";
import { inferChatTopics, planChatAiParticipation } from "../lib/chat/ai-planner.ts";
import {
  applyChatIntentContext,
  decideChatAiReply,
  inferChatIntentFallback,
  parseChatIntentAnalysis,
} from "../lib/chat/intent.ts";
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

test("结构化意图结果会被严格解析，格式错误不会被当作有效判断", () => {
  const result = parseChatIntentAnalysis(JSON.stringify({
    intent: "seeking_comfort", emotion: "sad", interaction_target: "group",
    needs_response: true, response_style: ["empathetic", "casual"],
    context_dependency: "medium", reason: "明确请求陪伴", confidence: 0.91,
  }));
  assert.equal(result.intent, "seeking_comfort");
  assert.equal(result.needsResponse, true);
  assert.throws(() => parseChatIntentAnalysis('{"intent":"invented"}'), /CHAT_INTENT/);
  assert.throws(() => parseChatIntentAnalysis("not json"), /CHAT_INTENT_INVALID_JSON/);
});

test("意图概率区分求助、闲聊、陈述、通知和无明确意图", () => {
  const trigger = message();
  const common = {
    trigger, parent: null, recentMessages: [trigger], recent10AiCount: 0,
    recent30AiShare: 0, consecutiveAiCount: 0, random: () => 0.5,
  };
  const analysis = (intent, needsResponse = false) => ({
    intent, emotion: "neutral", interactionTarget: "group", needsResponse,
    responseStyles: ["casual"], contextDependency: "low", reason: "测试", confidence: 1,
  });
  assert.equal(decideChatAiReply({ ...common, analysis: analysis("seeking_advice", true) }).shouldReply, true);
  assert.equal(decideChatAiReply({ ...common, analysis: analysis("casual_chat") }).shouldReply, false);
  assert.equal(decideChatAiReply({ ...common, analysis: analysis("simple_statement") }).probability, 0.15);
  assert.equal(decideChatAiReply({ ...common, analysis: analysis("announcement") }).probability, 0.10);
  assert.equal(decideChatAiReply({ ...common, analysis: analysis("no_clear_intent") }).probability, 0);
});

test("群体提问获得加权，但近期 AI 密集时仍受防刷屏限制", () => {
  const trigger = message({ content: "这个问题该怎么处理？" });
  const analysis = {
    intent: "asking_question", emotion: "neutral", interactionTarget: "group",
    needsResponse: true, responseStyles: ["practical"], contextDependency: "medium",
    reason: "明确问题", confidence: 0.9,
  };
  const normal = decideChatAiReply({
    analysis, trigger, parent: null, recentMessages: [trigger], recent10AiCount: 0,
    recent30AiShare: 0, consecutiveAiCount: 0, random: () => 0.75,
  });
  assert.equal(normal.shouldReply, true);
  const crowded = decideChatAiReply({
    analysis, trigger, parent: null, recentMessages: [trigger], recent10AiCount: 5,
    recent30AiShare: 0.5, consecutiveAiCount: 2, random: () => 0.6,
  });
  assert.equal(crowded.shouldReply, false);
});

test("用户回答 AI 时识别为上下文延续，并优先保留较高回复概率", () => {
  const parent = message({ id: "ai-parent", senderType: "ai", senderId: "ai:mengxia", personaId: "mengxia" });
  const trigger = message({ content: "是的，就是那个。", replyToMessageId: parent.id });
  const fallback = inferChatIntentFallback({ trigger, parent });
  assert.equal(fallback.intent, "social_response");
  assert.equal(fallback.interactionTarget, "ai_persona");
  const decision = decideChatAiReply({
    analysis: fallback, trigger, parent, recentMessages: [parent, trigger],
    recent10AiCount: 2, recent30AiShare: 0.2, consecutiveAiCount: 0, random: () => 0.9,
  });
  assert.equal(decision.shouldReply, true);
  const corrected = applyChatIntentContext({
    ...fallback, intent: "asking_question", interactionTarget: "group",
  }, parent);
  assert.equal(corrected.intent, "social_response");
  assert.equal(corrected.interactionTarget, "ai_persona");
});

test("真人之间已经连续交流时，普通 AI 插话概率降低", () => {
  const recent = [
    message({ id: "h1", senderId: "human-a" }),
    message({ id: "h2", senderId: "human-b" }),
    message({ id: "h3", senderId: "human-a" }),
  ];
  const trigger = message({ id: "h4", senderId: "human-b" });
  const decision = decideChatAiReply({
    analysis: {
      intent: "casual_chat", emotion: "neutral", interactionTarget: "group",
      needsResponse: false, responseStyles: ["casual"], contextDependency: "medium",
      reason: "闲聊", confidence: 0.8,
    },
    trigger, parent: null, recentMessages: [...recent, trigger], recent10AiCount: 0,
    recent30AiShare: 0, consecutiveAiCount: 0, random: () => 0.3,
  });
  assert.equal(decision.humansAreConversing, true);
  assert.equal(decision.shouldReply, false);
});

test("模型失败时本地兜底不把负面情绪自动识别为求安慰", () => {
  const feelings = inferChatIntentFallback({
    trigger: message({ content: "今天真的很累。" }), parent: null,
  });
  assert.equal(feelings.intent, "sharing_feelings");
  assert.equal(feelings.needsResponse, false);
  const unclear = inferChatIntentFallback({ trigger: message({ content: "嗯" }), parent: null });
  assert.equal(unclear.intent, "no_clear_intent");
  const decision = decideChatAiReply({
    analysis: unclear, trigger: message({ content: "嗯" }), parent: null,
    recentMessages: [], recent10AiCount: 0, recent30AiShare: 0,
    consecutiveAiCount: 0, random: () => 0,
  });
  assert.equal(decision.shouldReply, false);
});

test("十二类群聊情境具有可区分、可复现的回复决策", () => {
  const neutral = (intent, needsResponse = false, interactionTarget = "group") => ({
    intent, emotion: "neutral", interactionTarget, needsResponse,
    responseStyles: ["casual"], contextDependency: "medium", reason: "固定测试集", confidence: 1,
  });
  const aiParent = message({ id: "ai-context", senderType: "ai", senderId: "ai:xiaolin", personaId: "xiaolin" });
  const humanParent = message({ id: "human-context", senderId: "human-b" });
  const cases = [
    ["难过并寻求安慰", neutral("seeking_comfort", true), null, 0.85],
    ["开心但未求回应", { ...neutral("sharing_feelings"), emotion: "happy" }, null, 0.75],
    ["具体问题", neutral("asking_question", true), null, 0.80],
    ["生活经历", neutral("sharing_experience"), null, 0.70],
    ["表达观点", neutral("expressing_opinion"), null, 0.75],
    ["嗯哦哈哈", neutral("no_clear_intent"), null, 0],
    ["天气通知", neutral("announcement"), null, 0.10],
    ["回答 AI", neutral("social_response", true, "ai_persona"), aiParent, 0.94],
    ["回复真人", neutral("social_response", false, "human"), humanParent, 0.25],
    ["轻松闲聊", neutral("casual_chat"), null, 0.45],
    ["简单陈述", neutral("simple_statement"), null, 0.15],
    ["无法判断", neutral("uncertain"), null, 0],
  ];
  for (const [label, analysis, parent, expected] of cases) {
    const trigger = message({ id: `trigger-${label}`, replyToMessageId: parent?.id });
    const result = decideChatAiReply({
      analysis, trigger, parent, recentMessages: parent ? [parent, trigger] : [trigger],
      recent10AiCount: 0, recent30AiShare: 0, consecutiveAiCount: 0, random: () => 0.99,
    });
    assert.equal(Number(result.probability.toFixed(2)), expected, label);
  }
});
