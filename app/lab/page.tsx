import type { Metadata } from "next";

import LabClient from "./lab-client";

export const metadata: Metadata = {
  title: "AI 评论实验室 · Echo",
  description: "调试、比较并评价 Echo 的 AI 评论质量。",
};

export default function LabPage() {
  return <LabClient />;
}
