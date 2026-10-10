import type { Metadata } from "next";
import { Be_Vietnam_Pro } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const font = Be_Vietnam_Pro({ subsets: ["latin", "vietnamese"], weight: ["400", "500", "700"], display: "swap" });

export const metadata: Metadata = {
  title: "Next.js + dewee-webchat",
  description: "Embed a Dewee AI agent chat in a Next.js App Router app, running on Cloudflare Workers.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={font.className}>
      <body>{children}</body>
    </html>
  );
}
