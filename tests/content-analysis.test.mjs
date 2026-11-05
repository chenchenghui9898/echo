import assert from "node:assert/strict";
import test from "node:test";

import { fallbackContentAnalysis, parseContentAnalysis } from "../lib/community/content-analysis.ts";
import { CONTENT_SENSOR_EVALUATION_CASES } from "../lib/community/evaluation-cases.ts";

test("evaluation set covers four categories and ten required scenarios", () => {
  assert.equal(CONTENT_SENSOR_EVALUATION_CASES.length, 10);
  assert.deepEqual(new Set(CONTENT_SENSOR_EVALUATION_CASES.map((item) => item.category)), new Set(["观点", "心情", "日记", "作品"]));
});

test("fallback keeps category defaults distinct", () => {
  const results = ["观点", "心情", "日记", "作品"].map((category) =>
    fallbackContentAnalysis({ category, content: "测试内容" }).primaryInteractionDirection,
  );
  assert.equal(new Set(results).size, 4);
  assert.match(results[0], /观点|理由/);
  assert.match(results[1], /感受|接话/);
  assert.match(results[2], /经历|事件/);
  assert.match(results[3], /创作|表达/);
});

test("model analysis cannot silently replace the user-selected category", () => {
  const result = parseContentAnalysis({
    category: "心情",
    content: "今天终于拿到 offer 了！",
    raw: JSON.stringify({
      content_category: "作品",
      actual_content_type: ["开心分享", "生活近况"],
      emotions: ["开心", "兴奋"],
      expression_intent: ["分享喜悦"],
      topics: ["职场"],
      primary_interaction_direction: "朋友式祝贺",
      secondary_interaction_directions: ["回应具体细节"],
      unsuitable_interaction_directions: ["文学赏析", "安慰"],
      confidence: 1.7,
    }),
  });
  assert.equal(result.contentCategory, "心情");
  assert.equal(result.primaryInteractionDirection, "朋友式祝贺");
  assert.equal(result.confidence, 1);
  assert.ok(result.unsuitableInteractionDirections.includes("文学赏析"));
});

test("insufficient model fields fall back without inventing emotions", () => {
  const result = parseContentAnalysis({
    category: "日记",
    content: "上午洗了床单，下午去修自行车。",
    raw: JSON.stringify({ confidence: 0.2 }),
  });
  assert.deepEqual(result.emotions, []);
  assert.match(result.primaryInteractionDirection, /经历|事件/);
  assert.ok(result.unsuitableInteractionDirections.length > 0);
});
