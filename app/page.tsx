"use client";

import { useState } from "react";
import GrantScanner from "@/components/GrantScanner";
import ApplicationTracker from "@/components/ApplicationTracker";
import DraftApplication from "@/components/DraftApplication";

type Tab = "scanner" | "tracker" | "draft";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "scanner", label: "Grant Scanner", icon: "🔍" },
  { id: "tracker", label: "Application Tracker", icon: "📋" },
  { id: "draft", label: "Draft Application", icon: "✍️" },
];

export default function Home() {
  const [tab, setTab] = useState<Tab>("scanner");

  return (
    <div className="flex flex-col flex-1">
      <header className="border-b border-white/40">
        <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-3">
          <button
            onClick={() => setTab("scanner")}
            className="-ml-2 flex items-center gap-3 rounded-xl bg-white/90 px-3 py-1.5 shadow-sm transition-colors hover:bg-white"
            title="Back to dashboard"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/burn-logo.png" alt="BURN Manufacturing" className="h-9 w-auto" />
            <span className="h-7 w-px bg-[var(--border)]" />
            <span className="font-serif text-lg font-semibold leading-tight text-[var(--ink)]">
              Grant Intelligence
            </span>
          </button>

          <nav className="flex gap-2">
            {TABS.map((t) => (
              <TabButton key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>
                {t.icon} {t.label}
              </TabButton>
            ))}
          </nav>

          <p className="hidden text-xs italic tracking-wide text-[var(--ink-muted)] lg:block">
            found · vetted · funded
          </p>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        {tab === "scanner" && <GrantScanner />}
        {tab === "tracker" && <ApplicationTracker />}
        {tab === "draft" && <DraftApplication />}
      </main>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number; size: number }[]>([]);

  function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
    const button = e.currentTarget;
    const rect = button.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 1.6;
    const id = Date.now();
    setRipples((prev) => [
      ...prev,
      { id, x: e.clientX - rect.left - size / 2, y: e.clientY - rect.top - size / 2, size },
    ]);
    window.setTimeout(() => {
      setRipples((prev) => prev.filter((r) => r.id !== id));
    }, 550);
    onClick();
  }

  return (
    <button
      onClick={handleClick}
      className={`relative overflow-hidden rounded-full px-4 py-2 text-sm font-medium shadow-sm transition-colors ${
        active
          ? "bg-white text-[var(--accent)]"
          : "bg-white/75 text-[var(--ink)]/75 hover:bg-white"
      }`}
    >
      {children}
      {ripples.map((r) => (
        <span
          key={r.id}
          className="pointer-events-none absolute rounded-full bg-[var(--accent)]/25"
          style={{
            left: r.x,
            top: r.y,
            width: r.size,
            height: r.size,
            animation: "tab-ripple 0.55s ease-out",
          }}
        />
      ))}
    </button>
  );
}
 
