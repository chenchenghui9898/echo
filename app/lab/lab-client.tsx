"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { toggleContentReaction } from "@/lib/ai-lab/feedback-rules";

import type {
  CommentEvaluation,
  InteractionPromptVersion,
  ModelConfigSnapshot,
  PromptVersion,
  RunDetail,
  RunSummary,
  StyleFeedback,
  StyleReasonCode,
} from "@/lib/ai-lab/types";

import styles from "./lab.module.css";

type LabState = {
  promptVersions: PromptVersion[];
  interactionPromptVersions: InteractionPromptVersion[];
  runs: RunSummary[];
  modelConfig: ModelConfigSnapshot;
  keyConfigured: boolean;
};

type ApiError = { error?: string; runId?: string };

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & ApiError;
  if (!response.ok) throw new Error(payload.error || "请求失败，请稍后重试。");
  return payload;
}

function formatTime(value?: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusLabel(status: RunSummary["status"]) {
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  return "生成中";
}

function interactionScopeLabel(scope: InteractionPromptVersion["scope"]) {
  return {
    content_sensor: "内容感受器",
    final_comment: "最终评论生成",
    strategy_viewpoint: "观点策略",
    strategy_mood: "心情策略",
    strategy_diary: "日记策略",
    strategy_work: "作品策略",
  }[scope];
}

export default function LabClient() {
  const [labState, setLabState] = useState<LabState | null>(null);
  const [selectedPromptId, setSelectedPromptId] = useState("");
  const [promptName, setPromptName] = useState("");
  const [promptBody, setPromptBody] = useState("");
  const [promptNotes, setPromptNotes] = useState("");
  const [selectedInteractionPromptId, setSelectedInteractionPromptId] = useState("");
  const [interactionPromptName, setInteractionPromptName] = useState("");
  const [interactionPromptBody, setInteractionPromptBody] = useState("");
  const [interactionPromptNotes, setInteractionPromptNotes] = useState("");
  const [work, setWork] = useState("");
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSavingPrompt, setIsSavingPrompt] = useState(false);
  const [pageError, setPageError] = useState("");
  const [notice, setNotice] = useState("");
  const submittingRef = useRef(false);

  const applyPrompt = useCallback((prompt: PromptVersion) => {
    setSelectedPromptId(prompt.id);
    setPromptName(prompt.name);
    setPromptBody(prompt.body);
    setPromptNotes(prompt.notes);
  }, []);

  const loadState = useCallback(async (preferredPromptId?: string) => {
    const response = await fetch("/api/lab/state", { cache: "no-store" });
    const nextState = await readJson<LabState>(response);
    setLabState(nextState);
    const selected =
      nextState.promptVersions.find(
        (prompt) => prompt.id === preferredPromptId,
      ) ?? nextState.promptVersions[0];
    if (selected) applyPrompt(selected);
    const interactionSelected = nextState.interactionPromptVersions[0];
    if (interactionSelected) applyInteractionPrompt(interactionSelected);
    return nextState;
  }, [applyPrompt]);

  function applyInteractionPrompt(prompt: InteractionPromptVersion) {
    setSelectedInteractionPromptId(prompt.id);
    setInteractionPromptName(prompt.name);
    setInteractionPromptBody(prompt.body);
    setInteractionPromptNotes(prompt.notes);
  }

  async function saveInteractionPrompt() {
    const selected = labState?.interactionPromptVersions.find(
      (prompt) => prompt.id === selectedInteractionPromptId,
    );
    if (!selected || isSavingPrompt) return;
    setIsSavingPrompt(true); setPageError(""); setNotice("");
    try {
      const response = await fetch("/api/lab/interaction-prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: selected.scope,
          name: interactionPromptName,
          body: interactionPromptBody,
          notes: interactionPromptNotes,
        }),
      });
      const payload = await readJson<{ prompt: InteractionPromptVersion }>(response);
      await loadState();
      applyInteractionPrompt(payload.prompt);
      setNotice(`已保存 ${interactionScopeLabel(payload.prompt.scope)} v${payload.prompt.version}。`);
    } catch (error) {
      setPageError((error as Error).message);
    } finally { setIsSavingPrompt(false); }
  }

  const loadDetail = useCallback(async (runId: string) => {
    setLoadingDetailId(runId);
    setPageError("");
    try {
      const response = await fetch(`/api/lab/runs/${runId}`, {
        cache: "no-store",
      });
      const payload = await readJson<{ detail: RunDetail }>(response);
      setDetail(payload.detail);
    } catch (error) {
      setPageError((error as Error).message);
    } finally {
      setLoadingDetailId(null);
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const nextState = await loadState();
        if (active && nextState.runs[0]) await loadDetail(nextState.runs[0].id);
      } catch (error) {
        if (active) setPageError((error as Error).message);
      }
    })();
    return () => {
      active = false;
    };
  }, [loadDetail, loadState]);

  function choosePrompt(promptId: string) {
    const prompt = labState?.promptVersions.find((item) => item.id === promptId);
    if (prompt) applyPrompt(prompt);
  }

  async function savePrompt() {
    if (isSavingPrompt) return;
    setPageError("");
    setNotice("");
    setIsSavingPrompt(true);
    try {
      const response = await fetch("/api/lab/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: promptName,
          body: promptBody,
          notes: promptNotes,
        }),
      });
      const payload = await readJson<{ prompt: PromptVersion }>(response);
      await loadState(payload.prompt.id);
      setNotice(`已保存为 v${payload.prompt.version}，旧版本仍可回看。`);
    } catch (error) {
      setPageError((error as Error).message);
    } finally {
      setIsSavingPrompt(false);
    }
  }

  async function generateComments() {
    if (submittingRef.current || isGenerating) return;
    submittingRef.current = true;
    setIsGenerating(true);
    setPageError("");
    setNotice("");
    try {
      const response = await fetch("/api/lab/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: work, promptVersionId: selectedPromptId }),
      });
      const payload = (await response.json()) as {
        detail?: RunDetail;
        error?: string;
        runId?: string;
      };
      if (!response.ok || !payload.detail) {
        if (payload.runId) await loadDetail(payload.runId);
        throw new Error(payload.error || "生成评论失败，请稍后重试。");
      }
      setDetail(payload.detail);
      setNotice(`已生成 ${payload.detail.comments.length} 条评论。`);
      await loadState(selectedPromptId);
    } catch (error) {
      setPageError((error as Error).message);
      try {
        await loadState(selectedPromptId);
      } catch {
        // The generation error is more useful than a secondary refresh error.
      }
    } finally {
      submittingRef.current = false;
      setIsGenerating(false);
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link className={styles.brand} href="/">
            Echo<span>·</span>
          </Link>
          <span className={styles.headerDivider} />
          <span className={styles.headerTitle}>AI 评论实验室</span>
        </div>
        <Link className={styles.backLink} href="/">
          返回社区首页
        </Link>
      </header>

      <section className={styles.intro}>
        <div>
          <p className={styles.eyebrow}>COMMENT QUALITY WORKBENCH</p>
          <h1>把“像不像真人”拆开来看。</h1>
          <p>
            固定作品、提示词和模型配置，逐条评价评论。每次生成都会留下可复现的版本快照。
          </p>
        </div>
        {labState && <ModelCard state={labState} />}
      </section>

      {(pageError || notice) && (
        <div
          className={`${styles.message} ${pageError ? styles.messageError : styles.messageSuccess}`}
          role={pageError ? "alert" : "status"}
        >
          {pageError || notice}
        </div>
      )}

      <section className={styles.workspace}>
        <div className={styles.workPanel}>
          <div className={styles.sectionTitle}>
            <div>
              <span>01</span>
              <h2>作品输入</h2>
            </div>
            <small>{work.length.toLocaleString("zh-CN")} / 30,000 字符</small>
          </div>
          <textarea
            className={styles.workInput}
            value={work}
            onChange={(event) => setWork(event.target.value)}
            maxLength={30_000}
            placeholder="在这里粘贴诗歌、随笔、日记或观点文章……"
          />
          <div className={styles.generateRow}>
            <p>生成结果使用当前选中的提示词版本，不会自动修改提示词。</p>
            <button
              className={styles.primaryButton}
              type="button"
              disabled={isGenerating || !labState}
              onClick={generateComments}
            >
              {isGenerating ? "正在生成评论…" : "生成 AI 评论"}
            </button>
          </div>
        </div>

        <aside className={styles.promptPanel}>
          <div className={styles.sectionTitle}>
            <div>
              <span>02</span>
              <h2>提示词版本</h2>
            </div>
          </div>
          <label className={styles.fieldLabel} htmlFor="prompt-version">
            当前版本
          </label>
          <select
            id="prompt-version"
            className={styles.select}
            value={selectedPromptId}
            onChange={(event) => choosePrompt(event.target.value)}
          >
            {labState?.promptVersions.map((prompt) => (
              <option key={prompt.id} value={prompt.id}>
                v{prompt.version} · {prompt.name}
              </option>
            ))}
          </select>

          <label className={styles.fieldLabel} htmlFor="prompt-name">
            名称
          </label>
          <input
            id="prompt-name"
            className={styles.textInput}
            value={promptName}
            onChange={(event) => setPromptName(event.target.value)}
          />

          <label className={styles.fieldLabel} htmlFor="prompt-body">
            系统提示词正文
          </label>
          <textarea
            id="prompt-body"
            className={styles.promptInput}
            value={promptBody}
            onChange={(event) => setPromptBody(event.target.value)}
          />

          <label className={styles.fieldLabel} htmlFor="prompt-notes">
            版本备注
          </label>
          <textarea
            id="prompt-notes"
            className={styles.notesInput}
            value={promptNotes}
            onChange={(event) => setPromptNotes(event.target.value)}
            placeholder="记录这次调整想验证什么。"
          />
          <button
            className={styles.secondaryButton}
            type="button"
            disabled={isSavingPrompt}
            onClick={savePrompt}
          >
            {isSavingPrompt ? "保存中…" : "另存为新版本"}
          </button>
          <p className={styles.promptHint}>
            保存会创建新版本，不会覆盖当前版本。历史任务仍引用原来的正文快照。
          </p>

          <details className={styles.promptDetails}>
            <summary>内容感受器与分类策略</summary>
            <p className={styles.promptHint}>
              这些提示词独立版本化。新发布内容使用同类提示词的最新版本。
            </p>
            <label className={styles.fieldLabel} htmlFor="interaction-prompt-version">
              策略类型与版本
            </label>
            <select
              id="interaction-prompt-version"
              className={styles.select}
              value={selectedInteractionPromptId}
              onChange={(event) => {
                const prompt = labState?.interactionPromptVersions.find(
                  (item) => item.id === event.target.value,
                );
                if (prompt) applyInteractionPrompt(prompt);
              }}
            >
              {labState?.interactionPromptVersions.map((prompt) => (
                <option key={prompt.id} value={prompt.id}>
                  {interactionScopeLabel(prompt.scope)} · v{prompt.version}
                </option>
              ))}
            </select>
            <label className={styles.fieldLabel} htmlFor="interaction-prompt-name">名称</label>
            <input
              id="interaction-prompt-name"
              className={styles.textInput}
              value={interactionPromptName}
              onChange={(event) => setInteractionPromptName(event.target.value)}
            />
            <label className={styles.fieldLabel} htmlFor="interaction-prompt-body">提示词正文</label>
            <textarea
              id="interaction-prompt-body"
              className={styles.promptInput}
              value={interactionPromptBody}
              onChange={(event) => setInteractionPromptBody(event.target.value)}
            />
            <label className={styles.fieldLabel} htmlFor="interaction-prompt-notes">版本备注</label>
            <textarea
              id="interaction-prompt-notes"
              className={styles.notesInput}
              value={interactionPromptNotes}
              onChange={(event) => setInteractionPromptNotes(event.target.value)}
            />
            <button
              className={styles.secondaryButton}
              type="button"
              disabled={isSavingPrompt}
              onClick={saveInteractionPrompt}
            >
              另存策略新版本
            </button>
          </details>
        </aside>
      </section>

      <section className={styles.resultsSection}>
        <div className={styles.sectionHeading}>
          <div>
            <p>03 · REVIEW</p>
            <h2>本次评论与独立评价</h2>
          </div>
          {detail && (
            <div className={styles.runMeta}>
              v{detail.run.promptSnapshot.version} · {detail.run.modelConfig.model} ·{" "}
              {formatTime(detail.run.createdAt)}
            </div>
          )}
        </div>

        {!detail ? (
          <div className={styles.emptyState}>
            <span>✦</span>
            <p>生成一次评论，或从下方历史记录中打开已有结果。</p>
          </div>
        ) : detail.run.status === "failed" ? (
          <div className={styles.failedState}>
            <b>这次生成没有成功</b>
            <p>{detail.run.errorMessage}</p>
            <small>失败记录已保留，方便核对当时使用的配置。</small>
          </div>
        ) : detail.run.status === "running" ? (
          <div className={styles.emptyState}><p>这条任务仍处于生成中。</p></div>
        ) : (
          <div className={styles.commentList}>
            {detail.comments.map((comment) => (
              <CommentCard
                key={comment.id}
                comment={comment}
                onDetailChanged={setDetail}
                onEvaluationSaved={(evaluation) => {
                  setDetail((current) =>
                    current
                      ? {
                          ...current,
                          comments: current.comments.map((item) =>
                            item.id === comment.id
                              ? { ...item, evaluation }
                              : item,
                          ),
                        }
                      : current,
                  );
                }}
              />
            ))}
          </div>
        )}
      </section>

      <section className={styles.historySection}>
        <div className={styles.sectionHeading}>
          <div>
            <p>04 · ARCHIVE</p>
            <h2>生成记录</h2>
          </div>
          <div className={styles.historyActions}>
            <span>{labState?.runs.length ?? 0} 次实验</span>
            <a href="/api/lab/feedback/export" download>
              导出反馈 JSON
            </a>
          </div>
        </div>
        {!labState?.runs.length ? (
          <div className={styles.historyEmpty}>还没有生成记录。</div>
        ) : (
          <div className={styles.historyGrid}>
            <div className={styles.historyList}>
              {labState.runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  className={`${styles.historyItem} ${detail?.run.id === run.id ? styles.historyItemActive : ""}`}
                  onClick={() => loadDetail(run.id)}
                >
                  <span className={`${styles.statusDot} ${styles[`status_${run.status}`]}`} />
                  <span className={styles.historyBody}>
                    <b>{run.workPreview || "空作品"}</b>
                    <small>
                      {formatTime(run.createdAt)} · v{run.promptVersion} · {run.model}
                    </small>
                  </span>
                  <span className={styles.historyCount}>
                    {loadingDetailId === run.id
                      ? "读取中"
                      : run.status === "completed"
                        ? `${run.commentCount} 条`
                        : statusLabel(run.status)}
                  </span>
                </button>
              ))}
            </div>
            <RunInspector detail={detail} />
          </div>
        )}
      </section>
    </main>
  );
}

function ModelCard({ state }: { state: LabState }) {
  const { modelConfig } = state;
  return (
    <aside className={styles.modelCard}>
      <div className={styles.modelCardHeader}>
        <span className={state.keyConfigured ? styles.onlineDot : styles.offlineDot} />
        <b>{state.keyConfigured ? "API 已配置" : "等待 API Key"}</b>
      </div>
      <dl>
        <div><dt>提供方</dt><dd>DeepSeek</dd></div>
        <div><dt>模型</dt><dd>{modelConfig.model}</dd></div>
        <div><dt>温度</dt><dd>{modelConfig.temperature}</dd></div>
        <div><dt>每次生成</dt><dd>{modelConfig.commentCount} 条</dd></div>
      </dl>
      {!state.keyConfigured && (
        <p>在服务端 `.env.local` 配置密钥并重启后即可生成。</p>
      )}
    </aside>
  );
}

const STYLE_REASON_OPTIONS: Array<{
  code: StyleReasonCode;
  label: string;
}> = [
  { code: "ai_heavy", label: "AI 味儿太重" },
  { code: "formulaic", label: "说话太套路、像套模板" },
  { code: "vague", label: "表达空泛，没有说清楚" },
  { code: "over_analysis", label: "过度分析，把简单的事说复杂了" },
  { code: "unnatural", label: "语气不自然，不像真人会说的话" },
  { code: "over_interpretation", label: "过度解读原文，推断了我没表达的意思" },
  { code: "moralizing", label: "总在总结、升华或讲大道理" },
  { code: "verbose", label: "太啰嗦，重复表达" },
  { code: "other", label: "其他" },
];

function CommentCard({
  comment,
  onDetailChanged,
  onEvaluationSaved,
}: {
  comment: RunDetail["comments"][number];
  onDetailChanged: (detail: RunDetail) => void;
  onEvaluationSaved: (evaluation: CommentEvaluation) => void;
}) {
  const [humanLikeness, setHumanLikeness] = useState(
    comment.evaluation?.humanLikeness ?? null,
  );
  const [value, setValue] = useState(comment.evaluation?.value ?? null);
  const [notes, setNotes] = useState(comment.evaluation?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionStatus, setActionStatus] = useState("");
  const [stylePanelOpen, setStylePanelOpen] = useState(false);

  async function updateReaction(reaction: "agree" | "disagree") {
    if (actionBusy) return;
    const currentReaction =
      comment.contentReaction?.type === "agree" ||
      comment.contentReaction?.type === "disagree"
        ? comment.contentReaction.type
        : null;
    const nextReaction = toggleContentReaction(currentReaction, reaction);
    setActionBusy(true);
    setActionStatus("");
    try {
      const response = await fetch(
        `/api/lab/comments/${comment.id}/content-feedback`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reaction: nextReaction }),
        },
      );
      const payload = await readJson<{
        detail: RunDetail;
        generationError?: string | null;
      }>(response);
      onDetailChanged(payload.detail);
      setActionStatus(
        payload.generationError
          ? `反馈已保存；${payload.generationError}`
          : nextReaction
            ? "反馈已保存"
            : "已取消反馈",
      );
    } catch (error) {
      setActionStatus((error as Error).message);
    } finally {
      setActionBusy(false);
    }
  }

  async function sendReply() {
    if (actionBusy || !replyText.trim()) return;
    setActionBusy(true);
    setActionStatus("");
    try {
      const response = await fetch(
        `/api/lab/comments/${comment.id}/content-feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ replyText }),
        },
      );
      const payload = await readJson<{
        detail: RunDetail;
        generationError?: string | null;
      }>(response);
      onDetailChanged(payload.detail);
      setReplyText("");
      setReplyOpen(false);
      setActionStatus(
        payload.generationError
          ? `回复已保存；${payload.generationError}`
          : "回复已发送，AI 已继续回应",
      );
    } catch (error) {
      setActionStatus((error as Error).message);
    } finally {
      setActionBusy(false);
    }
  }

  async function likeStyle() {
    if (actionBusy) return;
    setMenuOpen(false);
    setActionBusy(true);
    setActionStatus("");
    try {
      const response = await fetch(
        `/api/lab/comments/${comment.id}/style-feedback`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "like", reasons: [], note: "" }),
        },
      );
      const payload = await readJson<{ detail: RunDetail }>(response);
      onDetailChanged(payload.detail);
      setActionStatus("已记录：喜欢这种表达");
    } catch (error) {
      setActionStatus((error as Error).message);
    } finally {
      setActionBusy(false);
    }
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setStatus("");
    try {
      const response = await fetch(
        `/api/lab/comments/${comment.id}/evaluation`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ humanLikeness, value, notes }),
        },
      );
      const payload = await readJson<{ evaluation: CommentEvaluation }>(response);
      onEvaluationSaved(payload.evaluation);
      setStatus("已保存");
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className={styles.commentCard}>
      <header className={styles.commentHeader}>
        <div>
          <span className={styles.commentNumber}>
            {String(comment.position + 1).padStart(2, "0")}
          </span>
          <b>{comment.persona.name}</b>
          <em>AI</em>
          {comment.trigger !== "initial" && (
            <small>
              {comment.trigger === "agreement" ? "因赞同追加" : "回应用户回复"}
            </small>
          )}
        </div>
        <div className={styles.moreWrap}>
          <button
            type="button"
            className={styles.moreButton}
            aria-label="语言风格反馈"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            ···
          </button>
          {menuOpen && (
            <div className={styles.styleMenu} role="menu">
              <button type="button" role="menuitem" onClick={likeStyle}>
                {comment.styleFeedback?.type === "like" ? "✓ " : ""}
                喜欢这种表达
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setStylePanelOpen(true);
                }}
              >
                {comment.styleFeedback?.type === "dislike" ? "✓ " : ""}
                不喜欢这种表达
              </button>
            </div>
          )}
        </div>
      </header>

      <p className={styles.commentText}>{comment.content}</p>

      <div className={styles.commentActions}>
        <button
          type="button"
          aria-pressed={comment.contentReaction?.type === "agree"}
          className={comment.contentReaction?.type === "agree" ? styles.actionActive : ""}
          disabled={actionBusy}
          onClick={() => updateReaction("agree")}
        >
          赞同
        </button>
        <button
          type="button"
          aria-pressed={comment.contentReaction?.type === "disagree"}
          className={comment.contentReaction?.type === "disagree" ? styles.actionActive : ""}
          disabled={actionBusy}
          onClick={() => updateReaction("disagree")}
        >
          反对
        </button>
        <button
          type="button"
          aria-expanded={replyOpen}
          disabled={actionBusy}
          onClick={() => setReplyOpen((open) => !open)}
        >
          回复{comment.userReplies.length ? ` ${comment.userReplies.length}` : ""}
        </button>
        {comment.styleFeedback && (
          <span className={styles.styleState}>
            {comment.styleFeedback.type === "like"
              ? "已喜欢这种表达"
              : `已提交表达问题${comment.styleFeedback.reasons.length ? ` · ${comment.styleFeedback.reasons.length} 项` : ""}`}
          </span>
        )}
      </div>

      {replyOpen && (
        <div className={styles.replyComposer}>
          <textarea
            value={replyText}
            maxLength={2_000}
            onChange={(event) => setReplyText(event.target.value)}
            placeholder={`回复 ${comment.persona.name}……`}
          />
          <div>
            <span>{replyText.length} / 2,000</span>
            <button
              type="button"
              disabled={actionBusy || !replyText.trim()}
              onClick={sendReply}
            >
              {actionBusy ? "发送中…" : "发送回复"}
            </button>
          </div>
        </div>
      )}

      {comment.userReplies.length > 0 && (
        <div className={styles.userReplies}>
          {comment.userReplies.map((reply) => (
            <div key={reply.id}>
              <b>你的回复</b>
              <p>{reply.replyText}</p>
              <time>{formatTime(reply.createdAt)}</time>
            </div>
          ))}
        </div>
      )}

      {actionStatus && (
        <p className={styles.actionStatus} role="status">
          {actionStatus}
        </p>
      )}

      <details className={styles.researchEvaluation}>
        <summary>实验室标注：真人感与内容价值</summary>
        <div className={styles.evaluationGrid}>
          <fieldset>
            <legend>真人感</legend>
            <div className={styles.choiceRow}>
              <ChoiceButton
                active={humanLikeness === "human"}
                onClick={() => setHumanLikeness(humanLikeness === "human" ? null : "human")}
              >像真人</ChoiceButton>
              <ChoiceButton
                active={humanLikeness === "not_human"}
                onClick={() => setHumanLikeness(humanLikeness === "not_human" ? null : "not_human")}
              >不像真人</ChoiceButton>
            </div>
          </fieldset>
          <fieldset>
            <legend>内容价值</legend>
            <div className={styles.choiceRow}>
              <ChoiceButton
                active={value === "valuable"}
                onClick={() => setValue(value === "valuable" ? null : "valuable")}
              >有价值</ChoiceButton>
              <ChoiceButton
                active={value === "not_valuable"}
                onClick={() => setValue(value === "not_valuable" ? null : "not_valuable")}
              >没有价值</ChoiceButton>
            </div>
          </fieldset>
          <label>
            <span>其他备注</span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="记录具体措辞、判断依据或问题……"
            />
          </label>
          <div className={styles.saveEvaluationRow}>
            <span>{status}</span>
            <button type="button" disabled={saving} onClick={save}>
              {saving ? "保存中…" : "保存标注"}
            </button>
          </div>
        </div>
      </details>

      {stylePanelOpen && (
        <StyleFeedbackPanel
          key={comment.styleFeedback?.updatedAt ?? "new"}
          commentId={comment.id}
          existing={comment.styleFeedback}
          onClose={() => setStylePanelOpen(false)}
          onSaved={(nextDetail) => {
            onDetailChanged(nextDetail);
            setStylePanelOpen(false);
            setActionStatus("语言风格反馈已提交");
          }}
        />
      )}
    </article>
  );
}

function StyleFeedbackPanel({
  commentId,
  existing,
  onClose,
  onSaved,
}: {
  commentId: string;
  existing: StyleFeedback | null;
  onClose: () => void;
  onSaved: (detail: RunDetail) => void;
}) {
  const [reasons, setReasons] = useState<StyleReasonCode[]>(
    existing?.type === "dislike" ? existing.reasons : [],
  );
  const [note, setNote] = useState(
    existing?.type === "dislike" ? existing.note : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function toggleReason(reason: StyleReasonCode) {
    setReasons((current) =>
      current.includes(reason)
        ? current.filter((item) => item !== reason)
        : [...current, reason],
    );
  }

  async function submit() {
    if (saving) return;
    if (reasons.length === 0 && !note.trim()) {
      setError("请至少选择一个原因，或填写具体说明。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch(
        `/api/lab/comments/${commentId}/style-feedback`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "dislike", reasons, note }),
        },
      );
      const payload = await readJson<{ detail: RunDetail }>(response);
      onSaved(payload.detail);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.feedbackOverlay} role="presentation" onClick={onClose}>
      <section
        className={styles.feedbackPanel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`style-title-${commentId}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.feedbackPanelHeader}>
          <div>
            <h3 id={`style-title-${commentId}`}>你不喜欢这条评论的哪些地方？</h3>
            <p>可多选，帮助我们改善 AI 的表达。</p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}>×</button>
        </div>
        <div className={styles.reasonList}>
          {STYLE_REASON_OPTIONS.map((option) => (
            <label key={option.code}>
              <input
                type="checkbox"
                checked={reasons.includes(option.code)}
                onChange={() => toggleReason(option.code)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
        <label className={styles.styleNote}>
          <span>补充说明（选填）</span>
          <textarea
            value={note}
            maxLength={2_000}
            onChange={(event) => setNote(event.target.value)}
            placeholder="还可以具体说说哪里不合适"
          />
        </label>
        {error && <p className={styles.panelError} role="alert">{error}</p>}
        <div className={styles.panelActions}>
          <button type="button" onClick={onClose}>取消</button>
          <button type="button" disabled={saving} onClick={submit}>
            {saving ? "提交中…" : existing?.type === "dislike" ? "更新反馈" : "提交反馈"}
          </button>
        </div>
      </section>
    </div>
  );
}

function ChoiceButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={active ? styles.choiceActive : ""}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function RunInspector({ detail }: { detail: RunDetail | null }) {
  if (!detail) {
    return <div className={styles.inspectorEmpty}>选择一条记录查看完整快照。</div>;
  }
  const { run, work } = detail;
  return (
    <article className={styles.inspector}>
      <div className={styles.inspectorTopline}>
        <span>{statusLabel(run.status)}</span>
        <time>{formatTime(run.createdAt)}</time>
      </div>
      <h3>作品原文</h3>
      <div className={styles.workSnapshot}>{work.content}</div>
      {detail.contentAnalysis && (
        <details open>
          <summary>内容感受器分析</summary>
          <dl className={styles.snapshotList}>
            <div><dt>来源</dt><dd>{detail.contentAnalysis.source === "model" ? "DeepSeek 分析" : "低置信度回退"}</dd></div>
            <div><dt>提示词</dt><dd>v{detail.contentAnalysis.promptSnapshot.version} · {detail.contentAnalysis.promptSnapshot.name}</dd></div>
            <div><dt>置信度</dt><dd>{detail.contentAnalysis.analysis.confidence}</dd></div>
          </dl>
          <pre>{JSON.stringify(detail.contentAnalysis.analysis, null, 2)}</pre>
        </details>
      )}
      <details>
        <summary>查看当时的提示词与模型快照</summary>
        <dl className={styles.snapshotList}>
          <div><dt>提示词</dt><dd>v{run.promptSnapshot.version} · {run.promptSnapshot.name}</dd></div>
          <div><dt>模型</dt><dd>{run.modelConfig.model}</dd></div>
          <div><dt>参数</dt><dd>temperature {run.modelConfig.temperature} / max tokens {run.modelConfig.maxTokens}</dd></div>
          <div><dt>输出协议</dt><dd>{run.modelConfig.outputContractVersion}</dd></div>
          {run.usage?.totalTokens && <div><dt>Token</dt><dd>{run.usage.totalTokens}</dd></div>}
        </dl>
        <pre>{run.promptSnapshot.body}</pre>
      </details>
    </article>
  );
}
