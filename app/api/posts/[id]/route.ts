import {
  deleteCommunityPost,
  getCommunityPost,
  getCommunityRequestContext,
} from "@/lib/community/repository";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const post = await getCommunityPost(id);
  return post
    ? Response.json({ post })
    : Response.json({ error: "没有找到这篇作品。" }, { status: 404 });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let requestContext;
  try {
    requestContext = await getCommunityRequestContext();
  } catch (error) {
    console.error("Failed to initialize community data source", error);
    return Response.json({ error: "删除服务尚未正确配置。" }, { status: 503 });
  }
  return (await deleteCommunityPost(requestContext, id))
    ? Response.json({ deleted: true })
    : Response.json({ error: "没有找到这篇作品。" }, { status: 404 });
}
