import { CHAT_AI_EVALUATION_CASES } from "../tests/chat-ai-cases.ts";

const personaByCase = [
  "xiaolin", "mengxia", "ayao", "xucheng", "laotao",
  "xucheng", "ayao", "zhouye", "xiaolin", "mengxia",
];

async function evaluate(index: number) {
  const testCase = CHAT_AI_EVALUATION_CASES[index];
  const baseUrl = process.env.ECHO_CHAT_EVAL_URL || "http://localhost:3202";
  const token = process.env.ECHO_WORKER_TOKEN || "";
  let lastError = "测试生成失败。";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/internal/chat-ai-evaluate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ content: testCase.content, personaId: personaByCase[index] }),
    });
    const result = await response.json() as { message?: string; persona?: string; error?: string };
    if (response.ok && result.message) {
      return { id: testCase.id, label: testCase.label, input: testCase.content, persona: result.persona, output: result.message, attempts: attempt };
    }
    lastError = result.error || `Case ${testCase.id} failed`;
  }
  return { id: testCase.id, label: testCase.label, input: testCase.content, persona: personaByCase[index], error: lastError };
}

const results = [];
for (let index = 0; index < CHAT_AI_EVALUATION_CASES.length; index += 2) {
  results.push(...await Promise.all([evaluate(index), evaluate(index + 1)]));
}
console.log(JSON.stringify(results, null, 2));
if (results.some((result) => "error" in result)) process.exitCode = 1;
