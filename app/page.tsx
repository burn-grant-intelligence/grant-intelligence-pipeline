"use client";

import { useState } from "react";
import GrantScanner from "@/components/GrantScanner";
import ApplicationTracker from "@/components/ApplicationTracker";
import DraftApplication from "@/components/DraftApplication";

type Tab = "scanner" | "tracker" | "draft";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "scanner", label: "Discover", icon: "🔍" },
  { id: "tracker", label: "Pipeline", icon: "📋" },
  { id: "draft", label: "Draft", icon: "✍️" },
];

export default function Home() {
  const [tab, setTab] = useState<Tab>("scanner");

  return (
    <div className="flex flex-col flex-1">
      <header className="border-b border-white/40">
        <div className="flex items-center justify-between px-6 py-4">
          <button
            onClick={() => setTab("scanner")}
            className="-ml-3 flex items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-white/70 active:bg-white/90"
            title="Back to dashboard"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-[var(--accent)] text-white">
              🔥
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-[var(--accent)]">
                Burn Manufacturing
              </p>
              <h1 className="font-serif text-xl font-semibold leading-tight text-[var(--ink)]">
                Grant Intelligence
              </h1>
            </div>
          </button>
          <p className="hidden text-xs italic tracking-wide text-[var(--ink-muted)] sm:block">
            found · vetted · funded
          </p>
        </div>
        <nav className="flex gap-2 px-6 pb-4">
          {TABS.map((t) => (
            <TabButton key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>
              {t.icon} {t.label}
            </TabButton>
          ))}
        </nav>
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
      className={`relative overflow-hidden rounded-full px-4 py-2 text-sm font-medium transition-colors ${
        active
          ? "bg-white/90 text-[var(--accent)] shadow-sm"
          : "text-[var(--ink)]/75 hover:bg-white/40"
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
