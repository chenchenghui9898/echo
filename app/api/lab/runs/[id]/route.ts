import { getRunDetail } from "@/lib/ai-lab/storage";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const detail = await getRunDetail(id);
    if (!detail) {
      return Response.json({ error: "没有找到这条生成记录。" }, { status: 404 });
    }
    return Response.json({ detail });
  } catch (error) {
    console.error("Failed to load generation run", error);
    return Response.json(
      { error: "无法读取生成记录，请检查服务端日志。" },
      { status: 500 },
    );
  }
}
