import { saveEvaluation } from "@/lib/ai-lab/storage";
import type { CommentEvaluation } from "@/lib/ai-lab/types";

const humanValues = new Set(["human", "not_human", null]);
const valueValues = new Set(["valuable", "not_valuable", null]);

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "请求内容不是有效的 JSON。" }, { status: 400 });
  }

  const { humanLikeness, value, notes } = (payload ?? {}) as Record<
    string,
    unknown
  >;
  if (!humanValues.has(humanLikeness as string | null)) {
    return Response.json({ error: "真人感评价值无效。" }, { status: 400 });
  }
  if (!valueValues.has(value as string | null)) {
    return Response.json({ error: "价值评价值无效。" }, { status: 400 });
  }
  if (typeof notes !== "string" || notes.length > 4000) {
    return Response.json({ error: "备注格式无效或内容过长。" }, { status: 400 });
  }

  try {
    const { id } = await context.params;
    const evaluation = await saveEvaluation({
      commentId: id,
      humanLikeness:
        humanLikeness as CommentEvaluation["humanLikeness"],
      value: value as CommentEvaluation["value"],
      notes,
    });
    if (!evaluation) {
      return Response.json({ error: "没有找到这条评论。" }, { status: 404 });
    }
    return Response.json({ evaluation });
  } catch (error) {
    console.error("Failed to save comment evaluation", error);
    return Response.json(
      { error: "无法保存评价，请检查服务端日志。" },
      { status: 500 },
    );
  }
}
