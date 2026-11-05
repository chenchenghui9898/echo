import "server-only";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";

const VISITOR_COOKIE = "echo_visitor_id";
const ADJECTIVES = ["安静", "晴朗", "缓慢", "清醒", "温和", "自在", "认真", "轻盈"];
const NOUNS = ["山雀", "灯影", "树梢", "溪流", "纸船", "晚风", "苔藓", "云朵"];

function hash(value: string) {
  let result = 0;
  for (const character of value) result = (result * 31 + character.charCodeAt(0)) >>> 0;
  return result;
}

export type ChatIdentity = {
  id: string;
  name: string;
};

export async function getOrCreateChatIdentity(): Promise<ChatIdentity> {
  const cookieStore = await cookies();
  let id = cookieStore.get(VISITOR_COOKIE)?.value;
  if (!id) {
    id = randomUUID();
    cookieStore.set(VISITOR_COOKIE, id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      secure: process.env.NODE_ENV === "production",
    });
  }
  const value = hash(id);
  const name = `${ADJECTIVES[value % ADJECTIVES.length]}${NOUNS[Math.floor(value / ADJECTIVES.length) % NOUNS.length]}·${id.slice(0, 4)}`;
  return { id, name };
}
