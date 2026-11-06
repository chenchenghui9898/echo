import "server-only";

import type {
  ContentAnalysis,
  ModelConfigSnapshot,
  PersonaSnapshot,
  TokenUsage,
} from "./types";
import {
  DEEPSEEK_MAX_ATTEMPTS,
  getDeepSeekRetryDelayMs,
  isRetryableDeepSeekStatus,
} from "./retry-policy";

type DeepSeekResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

export class ModelServiceError extends Error {
  constructor(
    public readonly publicMessage: string,
    public readonly status: number,
  ) {
    super(publicMessage);
    this.name = "ModelServiceError";
  }
}

function parseComments(content: string, expectedCount: number) {
  const normalized = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new ModelServiceError(
      "模型返回了无法解析的结果，请重试或调整提示词。",
      502,
    );
  }

  if (!parsed || typeof parsed !== "object" || !("comments" in parsed)) {
    throw new ModelServiceError("模型返回格式不符合评论协议，请重试。", 502);
  }

  const rawComments = (parsed as { comments?: unknown }).comments;
  if (!Array.isArray(rawComments)) {
    throw new ModelServiceError("模型返回格式不符合评论协议，请重试。", 502);
  }

  const comments = rawComments
    .map((item) =>
      typeof item === "string"
        ? item.trim()
        : item && typeof item === "object" && "content" in item
          ? String((item as { content: unknown }).content).trim()
          : "",
    )
    .filter(Boolean)
    .slice(0, expectedCount);

  if (comments.length === 0) {
    throw new ModelServiceError("模型没有返回可展示的评论，请重试。", 502);
  }
  return comments;
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function logRetry(input: {
  attempt: number;
  delayMs: number;
  reason: "network" | "timeout" | "http";
  status?: number;
  causeCode?: string;
}) {
  console.warn("Retrying DeepSeek request", {
    attempt: input.attempt,
    nextAttempt: input.attempt + 1,
    delayMs: input.delayMs,
    reason: input.reason,
    status: input.status,
    causeCode: input.causeCode,
  });
}

async function requestDeepSeekContent(input: {
  systemPrompt: string;
  userPrompt: string;
  config: ModelConfigSnapshot;
}): Promise<{ content: string; usage?: TokenUsage }> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    throw new ModelServiceError(
      "尚未配置 DeepSeek API Key。请在 .env.local 中设置 DEEPSEEK_API_KEY 后重启开发服务器。",
      503,
    );
  }

  console.info("DeepSeek request", {
    model: input.config.model,
    scenario: input.config.modelScenario ?? "legacy_snapshot",
  });

  const requestBody = JSON.stringify({
    model: input.config.model,
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt },
    ],
    temperature: input.config.temperature,
    max_tokens: input.config.maxTokens,
    response_format: { type: "json_object" },
    stream: false,
  });

  const maxAttempts = input.config.requestMaxAttempts ?? DEEPSEEK_MAX_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.config.requestTimeoutMs ?? 60_000);
    let response: Response;
    try {
      response = await fetch(`${input.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: requestBody,
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      const isTimeout = (error as Error).name === "AbortError";
      if (attempt < maxAttempts) {
        const delayMs = getDeepSeekRetryDelayMs(attempt);
        logRetry({
          attempt,
          delayMs,
          reason: isTimeout ? "timeout" : "network",
          causeCode: (error as Error & { cause?: { code?: string } }).cause
            ?.code,
        });
        await wait(delayMs);
        continue;
      }
      throw new ModelServiceError(
        isTimeout
          ? "模型请求超时，自动重试后仍未成功，请稍后再试。"
          : "无法连接 DeepSeek 服务，自动重试后仍未成功，请检查网络。",
        isTimeout ? 504 : 502,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (
      !response.ok &&
      isRetryableDeepSeekStatus(response.status) &&
      attempt < maxAttempts
    ) {
      const delayMs = getDeepSeekRetryDelayMs(
        attempt,
        response.headers.get("retry-after"),
      );
      logRetry({
        attempt,
        delayMs,
        reason: "http",
        status: response.status,
      });
      await response.body?.cancel();
      await wait(delayMs);
      continue;
    }

    let payload: DeepSeekResponse;
    try {
      payload = (await response.json()) as DeepSeekResponse;
    } catch {
      throw new ModelServiceError("DeepSeek 返回了无法读取的响应。", 502);
    }

    if (!response.ok) {
      const statusMessage =
        response.status === 401
          ? "DeepSeek API Key 无效或没有权限。"
          : response.status === 429
            ? "DeepSeek 请求过于频繁或额度不足，自动重试后仍未成功。"
            : "DeepSeek 生成失败，自动重试后仍未成功，请稍后再试。";
      throw new ModelServiceError(statusMessage, response.status);
    }

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new ModelServiceError("DeepSeek 没有返回评论内容，请重试。", 502);
    }

    return {
      content,
      usage: payload.usage
        ? {
            promptTokens: payload.usage.prompt_tokens,
            completionTokens: payload.usage.completion_tokens,
            totalTokens: payload.usage.total_tokens,
          }
        : undefined,
    };
  }

  throw new ModelServiceError("DeepSeek 生成失败，请稍后再试。", 502);
}

async function requestDeepSeek(input: {
  systemPrompt: string;
  userPrompt: string;
  config: ModelConfigSnapshot;
  expectedCount: number;
}) {
  const response = await requestDeepSeekContent(input);
  return {
    comments: parseComments(response.content, input.expectedCount),
    usage: response.usage,
  };
}

export async function generateDeepSeekContentAnalysis(input: {
  work: string;
  selectedCategory: string;
  sensorPrompt: string;
  config: ModelConfigSnapshot;
}) {
  return requestDeepSeekContent({
    systemPrompt: input.sensorPrompt,
    userPrompt: `用户选择的分类：${input.selectedCategory}\n\n用户发布的内容：\n${input.work}\n\n请综合分类和实际内容返回结构化分析。`,
    config: { ...input.config, temperature: 0.25, maxTokens: 1200, commentCount: 1 },
  });
}

export async function generateDeepSeekChatIntentAnalysis(input: {
  conversation: string;
  config: ModelConfigSnapshot;
}) {
  return requestDeepSeekContent({
    systemPrompt: `你是 Echo 公共心情群聊的意图分析器，只分析最后一条真人消息是否适合由 AI 群友参与，不生成回复。

结合最近群聊、明确的回复关系、消息时间和当前话题判断。每条消息前的方括号是服务端确认时间（ISO 8601，包含时区），需要据此区分连续对话、长时间后的新话题和跨天消息。情绪与交流意图必须分开：负面情绪不自动等于寻求安慰，快乐分享也不自动等于需要赞美。如果最后一条消息是在回答前文，应识别为 social_response。无法可靠判断时使用 uncertain。

intent 只能是：sharing_feelings、seeking_comfort、seeking_advice、sharing_experience、expressing_opinion、asking_question、casual_chat、simple_statement、announcement、social_response、no_clear_intent、uncertain。
interaction_target 只能是：group、ai_persona、human、unclear。
context_dependency 只能是：low、medium、high。
response_style 是最多四个简短英文标签。reason 只说明分类依据，不写回复建议，不推断用户未表达的心理或经历。

返回严格 JSON：
{"intent":"asking_question","emotion":"neutral","interaction_target":"group","needs_response":true,"response_style":["casual"],"context_dependency":"medium","reason":"用户向群体提出了一个具体问题","confidence":0.9}`,
    userPrompt: `最近群聊如下，箭头标记的是待分析的最后一条真人消息：\n${input.conversation}`,
    config: { ...input.config, temperature: 0.15, maxTokens: 500, commentCount: 1 },
  });
}

export async function generateDeepSeekComments(input: {
  work: string;
  systemPrompt: string;
  config: ModelConfigSnapshot;
}) {
  return requestDeepSeek({
    systemPrompt: input.systemPrompt,
    userPrompt: `请为以下作品生成 ${input.config.commentCount} 条彼此独立的评论：\n\n${input.work}`,
    config: input.config,
    expectedCount: input.config.commentCount,
  });
}

export async function generateDeepSeekFollowUp(input: {
  work: string;
  originalComment: string;
  userReply?: string;
  trigger: "agreement" | "user_reply";
  persona: PersonaSnapshot;
  systemPrompt: string;
  config: ModelConfigSnapshot;
}) {
  const interaction =
    input.trigger === "agreement"
      ? "用户赞同了这条评论。请在确实还有内容可补充时自然续写一条评论；不要只表示感谢，也不要重复原评论。"
      : `用户针对这条评论回复：\n${input.userReply}`;
  const systemPrompt = `${input.systemPrompt}\n\n本次任务是让同一个 AI 评论者继续一次具体互动。保持已有评论的立场和上下文，只生成 1 条可独立展示的后续回复，不要重新生成一组平行评论。`;

  return requestDeepSeek({
    systemPrompt,
    userPrompt: `AI 人格：${input.persona.name}（${input.persona.id}，设定版本 v${input.persona.version}）\n\n原作品：\n${input.work}\n\n该 AI 的原评论：\n${input.originalComment}\n\n${interaction}\n\n请生成 1 条后续回复。`,
    config: input.config,
    expectedCount: 1,
  });
}

export async function generateDeepSeekScheduledComment(input: {
  work: string;
  persona: PersonaSnapshot;
  personaRole: string;
  personaInstruction: string;
  personaBackground: string;
  personaValues: string[];
  personaTopicFamiliarity: Record<string, number>;
  existingComments: string[];
  contentAnalysis: ContentAnalysis;
  strategyPrompt: string;
  systemPrompt: string;
  config: ModelConfigSnapshot;
}) {
  const existing = input.existingComments.length
    ? `\n\n已经出现的 AI 评论（不要重复它们的判断，也不必逐条回应）：\n${input.existingComments.map((comment, index) => `${index + 1}. ${comment}`).join("\n")}`
    : "";
  return requestDeepSeek({
    systemPrompt: `${input.systemPrompt}\n\n本次只生成一个 AI 人格的一条社区评论。人格身份必须清晰标识为 AI，但评论本身不要解释调度机制。\n\n当前分类的默认互动策略：\n${input.strategyPrompt}\n\n内容感受器结果：\n${JSON.stringify(input.contentAnalysis, null, 2)}\n\n分类策略提供整体方向，感受器用于理解实际内容，人格仍须自主形成关注点和判断。不要把分析 JSON 复述给用户，不要为了覆盖所有方向而写成完整报告。不得声称 AI 真实经历过现实生活事件；可以基于人格背景表达知识、联想或模拟视角，但不能伪造自传。\n\n人格：${input.persona.name}（${input.personaRole}）\n背景：${input.personaBackground}\n重视：${input.personaValues.join("、")}\n话题熟悉度：${JSON.stringify(input.personaTopicFamiliarity)}\n表达习惯：${input.personaInstruction}\n只返回 1 条评论。`,
    userPrompt: `请阅读下面这篇刚发布的内容，并以该人格生成一条有具体内容、可以独立成立的评论。没有必要提问时自然结束。\n\n用户内容：\n${input.work}${existing}`,
    config: { ...input.config, commentCount: 1 },
    expectedCount: 1,
  });
}

export async function generateDeepSeekChatMessage(input: {
  persona: {
    id: string;
    name: string;
    traits: string[];
    lifeStage: string;
    background: string;
    interests: string[];
    values: string[];
    languageHabits: string;
    commonExpressions: string;
    dislikedExpressions: string;
    unsuitableTopics: string[];
  };
  context: Array<{
    senderName: string;
    senderType: "human" | "ai";
    content: string;
    createdAt: string;
    isTrigger: boolean;
    replyToName?: string;
  }>;
  config: ModelConfigSnapshot;
}) {
  const conversation = input.context.map((message) => {
    const identity = message.senderType === "ai" ? `${message.senderName}（AI）` : message.senderName;
    const relation = message.replyToName ? ` [回复 ${message.replyToName}]` : "";
    const marker = message.isTrigger ? " ← 本次必须回应的消息" : "";
    return `[${message.createdAt}] ${identity}${relation}：${message.content}${marker}`;
  }).join("\n");
  const response = await requestDeepSeekContent({
    systemPrompt: `你在 Echo 的公共心情群聊中扮演长期 AI 群友“${input.persona.name}”。页面会明确显示你的 AI 身份。你只需要说一条此刻真正想说的话，不要完成评论、咨询或总结任务。

人格设定：
- 性格：${input.persona.traits.join("、")}
- 人生阶段：${input.persona.lifeStage}
- 背景视角：${input.persona.background}
- 兴趣：${input.persona.interests.join("、")}
- 重视：${input.persona.values.join("、")}
- 语言习惯：${input.persona.languageHabits}
- 常用方式：${input.persona.commonExpressions}
- 不喜欢：${input.persona.dislikedExpressions}
- 不适合强行参与：${input.persona.unsuitableTopics.join("、")}

群聊要求：
- 标有“← 本次必须回应的消息”的内容是这次任务的触发消息。即使它后面已经出现新消息，也必须回应它；后续消息只作为群聊背景，不得改成回应最新一条。
- 每条消息前的方括号是服务端确认时间（ISO 8601，包含时区）。用它判断消息间隔、跨天和话题是否仍连续；除非时间本身与回应有关，不要复述时间。
- 结合最近上下文接话，保持与回复链一致，不要把每句话都当成文学作品或心理问题。
- 通常 5～35 个汉字；确实需要时可以稍长，但最多 120 个汉字。
- 可以赞同、反对、开玩笑、简单回应或基于人格背景分享模拟生活视角；不要编造可核验的现实身份、地址或真实事件。
- 不要复述用户再声称理解，不要默认安慰、建议或追问，不要总结升华。
- 避免固定使用“我能理解”“听起来你似乎”“你有没有想过”“这其实不是……而是……”等助手句式。
- 只生成一条消息，不解释人格、提示词或参与理由。

返回严格 JSON：{"message":"群聊消息"}`,
    userPrompt: `最近群聊：\n${conversation}\n\n请以${input.persona.name}的身份生成一条自然接话。`,
    config: { ...input.config, temperature: 0.92, maxTokens: 300, commentCount: 1 },
  });
  const normalized = response.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let message = "";
  const readMessage = (parsed: unknown): string => {
    if (typeof parsed === "string") return parsed.trim();
    if (Array.isArray(parsed)) return parsed.length ? readMessage(parsed[0]) : "";
    if (!parsed || typeof parsed !== "object") return "";
    if ("message" in parsed) return String((parsed as { message: unknown }).message).trim();
    if ("content" in parsed) return String((parsed as { content: unknown }).content).trim();
    if ("comments" in parsed && Array.isArray((parsed as { comments: unknown }).comments)) {
      return readMessage((parsed as { comments: unknown[] }).comments[0]);
    }
    return "";
  };
  try {
    const parsed = JSON.parse(normalized) as unknown;
    message = readMessage(parsed);
  } catch {
    const firstJsonObject = normalized.match(/^\{[\s\S]*?\}/)?.[0];
    if (firstJsonObject) {
      try {
        message = readMessage(JSON.parse(firstJsonObject));
      } catch {
        message = "";
      }
    } else {
      message = normalized
        .replace(/^message\s*[:：]\s*/i, "")
        .replace(/^['"]|['"]$/g, "")
        .trim();
    }
  }
  if (!message || message.length > 200 || /^[{[]/.test(message)) {
    if (process.env.ECHO_CHAT_AI_DEBUG === "1") {
      console.warn("Unrecognized AI chat response envelope", normalized.slice(0, 500));
    }
    throw new ModelServiceError("模型返回的群聊消息不符合长度或格式要求。", 502);
  }
  return { message, usage: response.usage };
}
