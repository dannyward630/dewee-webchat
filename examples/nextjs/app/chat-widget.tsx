"use client";

import { DeweeChat } from "dewee-webchat/react";

export function ChatWidget() {
  return (
    <DeweeChat
      endpoint="/api/dewee"
      title="Dewee"
      subtitle="Next.js on Cloudflare Workers"
      greeting="Xin chào!"
      intro="Ask about Dewee, or let an agent read a page for you."
      suggestions={[
        "What is Dewee?",
        "How do I add this widget to a Next.js app?",
        "Đọc https://dewee.sh và tóm tắt 1 câu.",
      ]}
      accentColor="#5446e8"
      theme="auto"
      position="bottom-right"
    />
  );
}
