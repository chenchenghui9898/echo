import { getFeedbackExport } from "@/lib/ai-lab/storage";

export async function GET() {
  try {
    const data = await getFeedbackExport();
    const date = new Date().toISOString().slice(0, 10);
    return new Response(`${JSON.stringify(data, null, 2)}\n`, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="echo-feedback-${date}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Failed to export AI feedback", error);
    return Response.json({ error: "无法导出反馈数据。" }, { status: 500 });
  }
}
