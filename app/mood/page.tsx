import type { Metadata } from "next";

import MoodChat from "./mood-client";

export const metadata: Metadata = {
  title: "心情群聊 · Echo",
  description: "Echo 所有人共同参与的公共心情群聊。",
};

export default function MoodPage() {
  return <MoodChat />;
}
