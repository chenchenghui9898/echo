import { deleteCommunityPost, getCommunityPost } from "@/lib/ai-lab/storage";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const post = await getCommunityPost(id);
  return post
    ? Response.json({ post })
    : Response.json({ error: "没有找到这篇作品。" }, { status: 404 });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return (await deleteCommunityPost(id))
    ? Response.json({ deleted: true })
    : Response.json({ error: "没有找到这篇作品。" }, { status: 404 });
}
