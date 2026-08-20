import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Grant Intelligence — BURN Manufacturing",
  description: "Daily funding discovery and application tracking for BURN Manufacturing.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-neutral-50 text-neutral-900">
        {children}
      </body>
    </html>
  );
}
