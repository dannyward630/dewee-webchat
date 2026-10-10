export interface Strings {
  title: string;
  greeting: string;
  greetingBody: string;
  placeholder: string;
  send: string;
  stop: string;
  newChat: string;
  close: string;
  open: string;
  thinking: string;
  thoughtFor: (s: number) => string;
  reasoning: string;
  toolRunning: string;
  toolDone: string;
  toolError: string;
  args: string;
  result: string;
  online: string;
  poweredBy: string;
  errorGeneric: string;
  stopped: string;
}

const en: Strings = {
  title: "Assistant",
  greeting: "Hi there 👋",
  greetingBody: "Ask me anything. I can look things up and use tools to help you.",
  placeholder: "Type a message…",
  send: "Send",
  stop: "Stop",
  newChat: "New conversation",
  close: "Close chat",
  open: "Open chat",
  thinking: "Thinking…",
  thoughtFor: (s) => `Thought for ${s}s`,
  reasoning: "Reasoning",
  toolRunning: "running",
  toolDone: "done",
  toolError: "error",
  args: "Arguments",
  result: "Result",
  online: "Online",
  poweredBy: "Powered by",
  errorGeneric: "Something went wrong. Please try again.",
  stopped: "Stopped.",
};

const vi: Strings = {
  title: "Trợ lý",
  greeting: "Xin chào 👋",
  greetingBody: "Bạn cần hỏi gì cứ nhắn nhé. Mình có thể tra cứu và dùng công cụ để hỗ trợ bạn.",
  placeholder: "Nhập tin nhắn…",
  send: "Gửi",
  stop: "Dừng",
  newChat: "Cuộc trò chuyện mới",
  close: "Đóng khung chat",
  open: "Mở khung chat",
  thinking: "Đang suy nghĩ…",
  thoughtFor: (s) => `Đã suy nghĩ ${s} giây`,
  reasoning: "Suy luận",
  toolRunning: "đang chạy",
  toolDone: "xong",
  toolError: "lỗi",
  args: "Tham số",
  result: "Kết quả",
  online: "Đang trực tuyến",
  poweredBy: "Vận hành bởi",
  errorGeneric: "Có lỗi xảy ra. Bạn thử lại giúp mình nhé.",
  stopped: "Đã dừng.",
};

export const locales: Record<string, Strings> = { en, vi };

export function pickStrings(locale?: string): Strings {
  const l = (locale || (typeof document !== "undefined" ? document.documentElement.lang : "") || (typeof navigator !== "undefined" ? navigator.language : "") || "en").toLowerCase();
  return l.startsWith("vi") ? vi : en;
}

export const icons = {
  chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8.5 8.5 0 0 1-12.4 7.6L3 21l1.4-5.1A8.5 8.5 0 1 1 21 12Z"/><path d="M8.5 11h.01M12 11h.01M15.5 11h.01"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  down: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`,
  newChat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.4 3.6a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`,
  stop: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>`,
  brain: `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24A2.5 2.5 0 0 0 14.5 2Z"/></svg>`,
  tool: `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z"/></svg>`,
};
