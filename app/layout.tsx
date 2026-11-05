import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Echo — 让每一个想法，都得到认真回应",
  description: "一个由你和多个 AI 人格共同构成的个人表达社区。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
