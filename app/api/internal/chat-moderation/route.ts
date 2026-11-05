import { getChatModerationRecords, updateChatReportStatus } from "@/lib/ai-lab/storage";
import type { ChatReportStatus } from "@/lib/ai-lab/types";

function authorized(request: Request) {
  if (process.env.NODE_ENV !== "production") return true;
  const token = process.env.ECHO_WORKER_TOKEN?.trim();
  return Boolean(token && request.headers.get("authorization") === `Bearer ${token}`);
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "未授权。" }, { status: 401 });
  }
  return Response.json(await getChatModerationRecords(), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function PATCH(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "未授权。" }, { status: 401 });
  }
  let payload: Record<string, unknown>;
  try {
    payload = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: "请求内容不是有效的 JSON。" }, { status: 400 });
  }
  const reportId = typeof payload.reportId === "string" ? payload.reportId.trim() : "";
  const statuses: ChatReportStatus[] = ["pending", "reviewed", "dismissed", "actioned"];
  const status = statuses.includes(payload.status as ChatReportStatus)
    ? payload.status as ChatReportStatus
    : null;
  if (!reportId || !status) {
    return Response.json({ error: "reportId 或处理状态无效。" }, { status: 400 });
  }
  const report = await updateChatReportStatus({ reportId, status });
  return report
    ? Response.json({ report })
    : Response.json({ error: "举报记录不存在。" }, { status: 404 });
}
