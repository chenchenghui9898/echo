"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import type { ChatMessageView, ChatReportReason, StyleReasonCode } from "@/lib/ai-lab/types";
import { canGroupChatMessages } from "@/lib/chat/rules";
import styles from "./mood.module.css";

type Identity = { id: string; name: string };
type ChatPayload = {
  messages: ChatMessageView[];
  hasMore: boolean;
  currentUser: Identity;
  config: { maxMessageLength: number; pollIntervalMs: number };
  syncToken?: string;
};

const DEFAULT_MAX_LENGTH = 1000;
const DEFAULT_POLL_INTERVAL = 3000;
const REPORT_REASONS: Array<{ value: ChatReportReason; label: string }> = [
  { value: "spam", label: "垃圾广告" },
  { value: "sexual", label: "色情低俗" },
  { value: "attack", label: "人身攻击" },
  { value: "harassment", label: "骚扰" },
  { value: "illegal", label: "违法违规" },
  { value: "other", label: "其他" },
];
const STYLE_REASONS: Array<{ value: StyleReasonCode; label: string }> = [
  { value: "ai_heavy", label: "AI 味儿太重" },
  { value: "formulaic", label: "套路或模板化" },
  { value: "vague", label: "空泛，没说清楚" },
  { value: "unnatural", label: "语气不自然" },
  { value: "over_analysis", label: "过度分析" },
  { value: "over_interpretation", label: "过度解读" },
  { value: "moralizing", label: "总结升华太多" },
  { value: "verbose", label: "太啰嗦" },
  { value: "other", label: "其他" },
];

function mergeMessages(current: ChatMessageView[], incoming: ChatMessageView[]) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

function formatTime(value: string) {
  const date = new Date(value);
  const now = new Date();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return time;
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${time}`;
}

function summary(content: string) {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 54 ? `${compact.slice(0, 54)}…` : compact;
}

export default function MoodChat() {
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [currentUser, setCurrentUser] = useState<Identity | null>(null);
  const [content, setContent] = useState("");
  const [replyingTo, setReplyingTo] = useState<ChatMessageView | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [maxLength, setMaxLength] = useState(DEFAULT_MAX_LENGTH);
  const [pollInterval, setPollInterval] = useState(DEFAULT_POLL_INTERVAL);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [reportingMessage, setReportingMessage] = useState<ChatMessageView | null>(null);
  const [reportReason, setReportReason] = useState<ChatReportReason>("spam");
  const [reportNote, setReportNote] = useState("");
  const [styleMessage, setStyleMessage] = useState<ChatMessageView | null>(null);
  const [styleReasons, setStyleReasons] = useState<StyleReasonCode[]>([]);
  const [styleNote, setStyleNote] = useState("");
  const [operationId, setOperationId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<ChatMessageView[]>([]);
  const hasMoreRef = useRef(false);
  const syncTokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const commitMessages = useCallback((next: ChatMessageView[]) => {
    messagesRef.current = next;
    setMessages(next);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior });
    setNewMessageCount(0);
  }, []);

  const isNearBottom = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return true;
    return container.scrollHeight - container.scrollTop - container.clientHeight < 120;
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/chat/messages", { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as ChatPayload & { error?: string };
        if (!response.ok) throw new Error(payload.error || "群聊加载失败。");
        return payload;
      })
      .then((payload) => {
        if (cancelled) return;
        commitMessages(payload.messages);
        setCurrentUser(payload.currentUser);
        setHasMore(payload.hasMore);
        hasMoreRef.current = payload.hasMore;
        setMaxLength(payload.config.maxMessageLength);
        setPollInterval(payload.config.pollIntervalMs);
        syncTokenRef.current = payload.syncToken ?? null;
        window.requestAnimationFrame(() => scrollToBottom("auto"));
      })
      .catch((caught: Error) => {
        if (!cancelled) setError(caught.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [commitMessages, scrollToBottom]);

  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    let busy = false;
    const poll = async () => {
      const latest = messagesRef.current.at(-1);
      if (busy) return;
      busy = true;
      try {
        const shouldFollow = isNearBottom();
        const syncQuery = syncTokenRef.current
          ? `&updatedAfter=${encodeURIComponent(syncTokenRef.current)}`
          : "";
        const response = await fetch(
          latest
            ? `/api/chat/messages?afterId=${encodeURIComponent(latest.id)}&limit=100${syncQuery}`
            : "/api/chat/messages",
          { cache: "no-store" },
        );
        if (!response.ok || cancelled) return;
        const payload = (await response.json()) as ChatPayload;
        syncTokenRef.current = payload.syncToken ?? syncTokenRef.current;
        if (!payload.messages.length) return;
        commitMessages(mergeMessages(messagesRef.current, payload.messages));
        if (shouldFollow) {
          window.requestAnimationFrame(() => scrollToBottom());
        } else {
          setNewMessageCount((count) => count + payload.messages.length);
        }
      } catch {
        // 短暂断网不打断阅读；发送操作仍会显示明确错误。
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(poll, pollInterval);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [commitMessages, isNearBottom, loading, pollInterval, scrollToBottom]);

  async function loadOlder() {
    const first = messagesRef.current[0];
    if (!first || loadingOlder || !hasMoreRef.current) return;
    const container = scrollRef.current;
    const previousHeight = container?.scrollHeight ?? 0;
    setLoadingOlder(true);
    setError("");
    try {
      const response = await fetch(
        `/api/chat/messages?beforeId=${encodeURIComponent(first.id)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json()) as ChatPayload & { error?: string };
      if (!response.ok) throw new Error(payload.error || "历史消息加载失败。");
      commitMessages(mergeMessages(payload.messages, messagesRef.current));
      setHasMore(payload.hasMore);
      hasMoreRef.current = payload.hasMore;
      window.requestAnimationFrame(() => {
        if (container) container.scrollTop += container.scrollHeight - previousHeight;
      });
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  }

  async function locateMessage(messageId: string) {
    let working = messagesRef.current;
    let canLoad = hasMoreRef.current;
    let attempts = 0;
    while (!working.some((message) => message.id === messageId) && canLoad && attempts < 20) {
      const first = working[0];
      if (!first) break;
      const response = await fetch(
        `/api/chat/messages?beforeId=${encodeURIComponent(first.id)}`,
        { cache: "no-store" },
      );
      if (!response.ok) break;
      const payload = (await response.json()) as ChatPayload;
      working = mergeMessages(payload.messages, working);
      canLoad = payload.hasMore;
      attempts += 1;
    }
    if (!working.some((message) => message.id === messageId)) {
      setError("暂时无法定位到被引用的消息。");
      return;
    }
    commitMessages(working);
    setHasMore(canLoad);
    hasMoreRef.current = canLoad;
    window.requestAnimationFrame(() => {
      document.getElementById(`message-${messageId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightedId(messageId);
      window.setTimeout(() => setHighlightedId(null), 1800);
    });
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const text = content.trim();
    if (!text || sending) return;
    setSending(true);
    setError("");
    try {
      const response = await fetch("/api/chat/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, replyToMessageId: replyingTo?.id }),
      });
      const payload = (await response.json()) as { message?: ChatMessageView; error?: string };
      if (!response.ok || !payload.message) throw new Error(payload.error || "消息发送失败。");
      commitMessages(mergeMessages(messagesRef.current, [payload.message]));
      setContent("");
      setReplyingTo(null);
      window.requestAnimationFrame(() => scrollToBottom());
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  async function deleteMessage(message: ChatMessageView) {
    if (operationId) return;
    setOperationId(message.id);
    setOpenMenuId(null);
    setError("");
    try {
      const response = await fetch(`/api/chat/messages/${message.id}`, { method: "DELETE" });
      const payload = await response.json() as { message?: ChatMessageView; error?: string };
      if (!response.ok || !payload.message) throw new Error(payload.error || "删除失败。");
      commitMessages(mergeMessages(messagesRef.current, [payload.message]));
      if (replyingTo?.id === message.id) setReplyingTo(null);
      setNotice("消息已删除");
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setOperationId(null);
    }
  }

  async function blockSender(message: ChatMessageView) {
    if (operationId) return;
    setOperationId(message.id);
    setOpenMenuId(null);
    setError("");
    try {
      const response = await fetch(`/api/chat/messages/${message.id}/block`, { method: "PUT" });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "屏蔽失败。");
      commitMessages(messagesRef.current.filter((item) => item.senderId !== message.senderId));
      setNotice(`已在当前群聊中屏蔽 ${message.senderName}`);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setOperationId(null);
    }
  }

  async function submitReport(event: FormEvent) {
    event.preventDefault();
    if (!reportingMessage || operationId) return;
    setOperationId(reportingMessage.id);
    setError("");
    try {
      const response = await fetch(`/api/chat/messages/${reportingMessage.id}/reports`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reportReason, note: reportNote }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "举报提交失败。");
      setReportingMessage(null);
      setReportNote("");
      setNotice("举报已提交，我们会保留记录供后续处理");
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setOperationId(null);
    }
  }

  async function saveStyleFeedback(
    message: ChatMessageView,
    type: "like" | "dislike",
    reasons: StyleReasonCode[] = [],
    note = "",
  ) {
    if (operationId) return;
    setOperationId(message.id);
    setOpenMenuId(null);
    setError("");
    try {
      const response = await fetch(`/api/chat/messages/${message.id}/style-feedback`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, reasons, note }),
      });
      const payload = await response.json() as {
        feedback?: { type: "like" | "dislike"; reasons: StyleReasonCode[]; note: string; updatedAt: string };
        error?: string;
      };
      if (!response.ok || !payload.feedback) throw new Error(payload.error || "反馈保存失败。");
      commitMessages(messagesRef.current.map((item) => item.id === message.id
        ? { ...item, styleFeedback: payload.feedback! }
        : item));
      setStyleMessage(null);
      setStyleReasons([]);
      setStyleNote("");
      setNotice(type === "like" ? "已记录：喜欢这种表达" : "表达反馈已保存");
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setOperationId(null);
    }
  }

  function openDislikePanel(message: ChatMessageView) {
    setOpenMenuId(null);
    setStyleMessage(message);
    setStyleReasons(message.styleFeedback?.type === "dislike" ? [...message.styleFeedback.reasons] : []);
    setStyleNote(message.styleFeedback?.type === "dislike" ? message.styleFeedback.note : "");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void sendMessage();
    }
  }

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/" aria-label="Echo 广场">Echo<span>·</span></Link>
        <div className={styles.roomTitle}>
          <strong>此刻</strong><span>公共心情群聊</span>
        </div>
        <nav className={styles.actions} aria-label="群聊导航">
          <Link href="/">广场</Link><Link className={styles.publishLink} href="/?compose=1">发布</Link>
        </nav>
      </header>

      <main className={styles.chat}>
        <div className={styles.roomNote}>这里是所有人共享的同一个房间。AI 群友会明确标注身份。</div>
        <div className={styles.scroller} ref={scrollRef} onScroll={() => {
          if (isNearBottom()) setNewMessageCount(0);
        }}>
          <div className={styles.stream} aria-live="polite" aria-busy={loading}>
            {hasMore && (
              <button className={styles.loadMore} onClick={loadOlder} disabled={loadingOlder}>
                {loadingOlder ? "正在加载…" : "查看更早的消息"}
              </button>
            )}
            {loading && <div className={styles.empty}>正在进入群聊…</div>}
            {!loading && messages.length === 0 && (
              <div className={styles.empty}><strong>房间里还很安静</strong><span>你可以写下第一句话。</span></div>
            )}
            {messages.map((message, index) => {
              const previous = messages[index - 1];
              const grouped = canGroupChatMessages(previous, message);
              const own = message.senderId === currentUser?.id;
              return (
                <article
                  id={`message-${message.id}`}
                  key={message.id}
                  className={`${styles.message} ${own ? styles.own : ""} ${message.senderType === "ai" ? styles.ai : ""} ${grouped ? styles.grouped : ""} ${highlightedId === message.id ? styles.highlighted : ""}`}
                >
                  <div className={styles.avatar} aria-hidden="true">{grouped ? "" : (message.senderAvatar ?? message.senderName.slice(0, 1))}</div>
                  <div className={styles.messageBody}>
                    {!grouped && <div className={styles.meta}><strong>{own ? "你" : message.senderName}</strong><span>{message.senderType === "ai" ? "AI" : "普通用户"}</span><time>{formatTime(message.createdAt)}</time></div>}
                    {message.status === "normal" && (
                      <div className={styles.moreWrap}>
                        <button
                          className={styles.moreButton}
                          type="button"
                          aria-label={`更多操作：${message.senderName}的消息`}
                          aria-expanded={openMenuId === message.id}
                          onClick={() => setOpenMenuId((current) => current === message.id ? null : message.id)}
                        >···</button>
                        {openMenuId === message.id && (
                          <div className={styles.messageMenu} role="menu">
                            {own && message.senderType === "human" && (
                              <button type="button" role="menuitem" onClick={() => void deleteMessage(message)}>删除消息</button>
                            )}
                            {!own && (
                              <button type="button" role="menuitem" onClick={() => {
                                setOpenMenuId(null); setReportingMessage(message); setReportReason("spam"); setReportNote("");
                              }}>举报消息</button>
                            )}
                            {!own && message.senderType === "human" && (
                              <button type="button" role="menuitem" onClick={() => void blockSender(message)}>屏蔽该用户</button>
                            )}
                            {message.senderType === "ai" && (
                              <>
                                <button type="button" role="menuitem" onClick={() => void saveStyleFeedback(message, "like")}>
                                  {message.styleFeedback?.type === "like" ? "✓ 已喜欢这种表达" : "喜欢这种表达"}
                                </button>
                                <button type="button" role="menuitem" onClick={() => openDislikePanel(message)}>
                                  {message.styleFeedback?.type === "dislike" ? "✓ 查看不喜欢的反馈" : "不喜欢这种表达"}
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    <div className={styles.bubble}>
                      {message.replyTo && (
                        <button className={styles.quote} onClick={() => void locateMessage(message.replyTo!.id)}>
                          <strong>回复 {message.replyTo.senderName}</strong>
                          <span>{message.replyTo.status === "deleted" ? "消息已删除" : summary(message.replyTo.content)}</span>
                        </button>
                      )}
                      <p>{message.status === "deleted" ? "此消息已删除" : message.content}</p>
                    </div>
                    {message.status === "normal" && (
                      <div className={styles.messageFooter}>
                        <button className={styles.replyAction} onClick={() => {
                          setReplyingTo(message);
                          inputRef.current?.focus();
                        }}>回复</button>
                        {message.senderType === "ai" && message.styleFeedback && (
                          <span className={styles.feedbackState}>
                            {message.styleFeedback.type === "like" ? "已喜欢这种表达" : "已提交表达反馈"}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
        {newMessageCount > 0 && (
          <button className={styles.newMessages} onClick={() => scrollToBottom()}>
            {newMessageCount} 条新消息
          </button>
        )}
      </main>

      {notice && <div className={styles.notice} role="status">{notice}</div>}

      <footer className={styles.composer}>
        <form onSubmit={sendMessage}>
          {replyingTo && (
            <div className={styles.replyPreview}>
              <div><strong>回复 {replyingTo.senderName}</strong><span>{summary(replyingTo.content)}</span></div>
              <button type="button" onClick={() => setReplyingTo(null)} aria-label="取消回复">×</button>
            </div>
          )}
          {error && <div className={styles.error} role="alert">{error}</div>}
          <div className={styles.inputRow}>
            <textarea
              ref={inputRef}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="在此刻说点什么……"
              rows={1}
              maxLength={maxLength}
              aria-label="群聊消息"
            />
            <button type="submit" disabled={!content.trim() || sending}>{sending ? "发送中" : "发送"}</button>
          </div>
          <div className={styles.composerHint}><span>Enter 发送 · Shift + Enter 换行</span><span>{content.length} / {maxLength}</span></div>
        </form>
      </footer>

      {reportingMessage && (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={() => setReportingMessage(null)}>
          <section className={styles.feedbackPanel} role="dialog" aria-modal="true" aria-labelledby="report-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className={styles.panelHeader}><div><span>COMMUNITY SAFETY</span><h2 id="report-title">举报这条消息</h2></div><button type="button" onClick={() => setReportingMessage(null)} aria-label="关闭">×</button></div>
            <form onSubmit={submitReport}>
              <label>举报原因</label>
              <div className={styles.reasonGrid}>
                {REPORT_REASONS.map((reason) => (
                  <label key={reason.value}><input type="radio" name="report-reason" value={reason.value} checked={reportReason === reason.value} onChange={() => setReportReason(reason.value)} /><span>{reason.label}</span></label>
                ))}
              </div>
              <label htmlFor="report-note">补充说明 <small>选填</small></label>
              <textarea id="report-note" value={reportNote} onChange={(event) => setReportNote(event.target.value)} maxLength={500} rows={3} placeholder="可以具体说明问题" />
              <div className={styles.panelActions}><button type="button" onClick={() => setReportingMessage(null)}>取消</button><button type="submit" disabled={operationId === reportingMessage.id}>提交举报</button></div>
            </form>
          </section>
        </div>
      )}

      {styleMessage && (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={() => setStyleMessage(null)}>
          <section className={styles.feedbackPanel} role="dialog" aria-modal="true" aria-labelledby="style-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className={styles.panelHeader}><div><span>AI VOICE FEEDBACK</span><h2 id="style-title">你不喜欢这条 AI 消息的哪些地方？</h2><p>可多选，反馈只用于后续人工分析。</p></div><button type="button" onClick={() => setStyleMessage(null)} aria-label="关闭">×</button></div>
            <form onSubmit={(event) => { event.preventDefault(); void saveStyleFeedback(styleMessage, "dislike", styleReasons, styleNote); }}>
              <div className={styles.reasonGrid}>
                {STYLE_REASONS.map((reason) => (
                  <label key={reason.value}><input type="checkbox" checked={styleReasons.includes(reason.value)} onChange={() => setStyleReasons((current) => current.includes(reason.value) ? current.filter((item) => item !== reason.value) : [...current, reason.value])} /><span>{reason.label}</span></label>
                ))}
              </div>
              <label htmlFor="style-note">补充说明 <small>选填</small></label>
              <textarea id="style-note" value={styleNote} onChange={(event) => setStyleNote(event.target.value)} maxLength={500} rows={3} placeholder="还可以具体说说哪里不合适" />
              <div className={styles.panelActions}><button type="button" onClick={() => setStyleMessage(null)}>取消</button><button type="submit" disabled={operationId === styleMessage.id || (!styleReasons.length && !styleNote.trim())}>保存反馈</button></div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
