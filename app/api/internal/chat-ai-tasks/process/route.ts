import { getChatAiTaskDiagnostics } from "@/lib/ai-lab/storage";
import { processDueChatAiTasks } from "@/lib/chat/ai-task-runner";

function authorized(request: Request) {
  const token = process.env.ECHO_WORKER_TOKEN?.trim();
  if (process.env.NODE_ENV === "production" && !token) return false;
  return !token || request.headers.get("authorization") === `Bearer ${token}`;
}

export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({ error: "未授权。" }, { status: 401 });
  return Response.json({ tasks: await getChatAiTaskDiagnostics() });
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "未授权。" }, { status: 401 });
  return Response.json(await processDueChatAiTasks());
}
