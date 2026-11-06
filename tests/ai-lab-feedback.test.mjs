import assert from "node:assert/strict";
import test from "node:test";

import {
  hasStyleFeedbackContent,
  isReplyRateLimited,
  shouldGenerateAgreementFollowUp,
  toggleContentReaction,
} from "../lib/ai-lab/feedback-rules.ts";
import {
  DEEPSEEK_MAX_ATTEMPTS,
  getDeepSeekRetryDelayMs,
  isRetryableDeepSeekStatus,
} from "../lib/ai-lab/retry-policy.ts";
import {
  DeepSeekModelConfigurationError,
  selectDeepSeekModel,
} from "../lib/ai-lab/model-selection.ts";

test("赞同和反对互斥，再次点击会取消", () => {
  assert.equal(toggleContentReaction(null, "agree"), "agree");
  assert.equal(toggleContentReaction("agree", "agree"), null);
  assert.equal(toggleContentReaction("agree", "disagree"), "disagree");
  assert.equal(toggleContentReaction("disagree", "agree"), "agree");
});

test("赞同追加只发生在首次切换到赞同且尚无追加评论时", () => {
  assert.equal(
    shouldGenerateAgreementFollowUp({
      previousReaction: null,
      nextReaction: "agree",
      hasExistingFollowUp: false,
    }),
    true,
  );
  assert.equal(
    shouldGenerateAgreementFollowUp({
      previousReaction: "agree",
      nextReaction: "agree",
      hasExistingFollowUp: false,
    }),
    false,
  );
  assert.equal(
    shouldGenerateAgreementFollowUp({
      previousReaction: "disagree",
      nextReaction: "agree",
      hasExistingFollowUp: true,
    }),
    false,
  );
});

test("回复频率限制使用三秒窗口", () => {
  const now = Date.parse("2026-10-22T10:00:03.000Z");
  assert.equal(isReplyRateLimited(undefined, now), false);
  assert.equal(
    isReplyRateLimited("2026-10-22T10:00:01.000Z", now),
    true,
  );
  assert.equal(
    isReplyRateLimited("2026-10-22T10:00:00.000Z", now),
    false,
  );
});

test("不喜欢表达必须至少包含原因或文字说明", () => {
  assert.equal(hasStyleFeedbackContent([], ""), false);
  assert.equal(hasStyleFeedbackContent(["vague"], ""), true);
  assert.equal(hasStyleFeedbackContent([], "具体搭配不准确"), true);
});

test("只重试临时性 DeepSeek HTTP 状态", () => {
  assert.equal(DEEPSEEK_MAX_ATTEMPTS, 2);
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryableDeepSeekStatus(status), true);
  }
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(isRetryableDeepSeekStatus(status), false);
  }
});

test("DeepSeek 重试采用短暂退避并限制 Retry-After 上限", () => {
  assert.equal(getDeepSeekRetryDelayMs(1), 600);
  assert.equal(getDeepSeekRetryDelayMs(2), 1_200);
  assert.equal(getDeepSeekRetryDelayMs(1, "1"), 1_000);
  assert.equal(getDeepSeekRetryDelayMs(1, "30"), 2_000);
  assert.equal(getDeepSeekRetryDelayMs(1, "invalid"), 600);
});

test("DeepSeek 场景模型优先于默认模型", () => {
  const selected = selectDeepSeekModel("chat_intent", {
    DEEPSEEK_MODEL_DEFAULT: "default-model",
    DEEPSEEK_MODEL_CHAT_INTENT: "intent-model",
  });

  assert.deepEqual(selected, {
    model: "intent-model",
    source: "DEEPSEEK_MODEL_CHAT_INTENT",
    usedLegacyDefault: false,
  });
});

test("未配置场景模型时回退到默认模型", () => {
  const selected = selectDeepSeekModel("comment", {
    DEEPSEEK_MODEL_DEFAULT: "default-model",
    DEEPSEEK_MODEL_COMMENT: "   ",
  });

  assert.equal(selected.model, "default-model");
  assert.equal(selected.source, "DEEPSEEK_MODEL_DEFAULT");
  assert.equal(selected.usedLegacyDefault, false);
});

test("默认模型缺失时给出明确的服务端配置错误", () => {
  assert.throws(
    () => selectDeepSeekModel("chat_reply", {}),
    (error) =>
      error instanceof DeepSeekModelConfigurationError &&
      error.message.includes("DEEPSEEK_MODEL_DEFAULT_MISSING"),
  );
});

test("迁移期间仍可把旧 DEEPSEEK_MODEL 作为默认模型", () => {
  const selected = selectDeepSeekModel("persona_dialogue", {
    DEEPSEEK_MODEL: "legacy-default-model",
  });

  assert.equal(selected.model, "legacy-default-model");
  assert.equal(selected.source, "DEEPSEEK_MODEL");
  assert.equal(selected.usedLegacyDefault, true);
});
