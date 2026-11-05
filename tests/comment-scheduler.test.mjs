import assert from "node:assert/strict";
import test from "node:test";

import { createCommentPlan, drawCommentCount, inferTopics, planSchedule, selectPersonas } from "../lib/community/planner.ts";

function sequence(values) {
  let index = 0;
  return () => values[index++ % values.length];
}

test("comment count follows configured bucket boundaries", () => {
  assert.equal(drawCommentCount(sequence([0.01, 0.5])), 0);
  assert.equal(drawCommentCount(sequence([0.1, 0])), 1);
  assert.equal(drawCommentCount(sequence([0.3, 0.99])), 4);
  assert.equal(drawCommentCount(sequence([0.7, 0.99])), 6);
  assert.equal(drawCommentCount(sequence([0.99, 0.99])), 9);
});

test("persona selection is unique and can include low activity personas", () => {
  const selected = selectPersonas({ topics: ["文学", "作品"], count: 9, random: sequence([0.02, 0.8, 0.3, 0.6]) });
  assert.equal(selected.length, 9);
  assert.equal(new Set(selected.map((persona) => persona.id)).size, 9);
  assert.ok(selected.some((persona) => persona.activity === "low"));
});

test("schedule stays inside the configured cycle and is ordered", () => {
  process.env.ECHO_SCHEDULER_TIME_SCALE = "1";
  const publishedAt = new Date("2026-01-01T00:00:00.000Z");
  const schedule = planSchedule({ publishedAt, count: 8, random: sequence([0.1, 0.3, 0.7, 0.2, 0.8]) });
  assert.equal(schedule.length, 8);
  const times = schedule.map((value) => new Date(value).getTime());
  assert.deepEqual([...times].sort((a, b) => a - b), times);
  assert.ok(times[0] >= publishedAt.getTime() + 30_000);
  assert.ok(times.at(-1) <= publishedAt.getTime() + 12 * 60 * 60_000);
});

test("development time scale compresses scheduled time", () => {
  process.env.ECHO_SCHEDULER_TIME_SCALE = "0.001";
  const publishedAt = new Date("2026-01-01T00:00:00.000Z");
  const plan = createCommentPlan({ content: "今天写了一首关于雨的诗。", type: "作品", publishedAt, random: sequence([0.3, 0.4, 0.2, 0.7, 0.1]) });
  assert.equal(plan.length, 3);
  assert.ok(new Date(plan[0].scheduledAt).getTime() - publishedAt.getTime() < 60_000);
});

test("topic inference combines declared type and textual cues", () => {
  const topics = inferTopics("今天加班时又在想人工智能会怎样改变工作。", "观点");
  assert.ok(topics.includes("观点"));
  assert.ok(topics.includes("职场"));
  assert.ok(topics.includes("科技"));
});
