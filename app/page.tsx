"use client";

import { useState } from "react";
import GrantScanner from "@/components/GrantScanner";
import ApplicationTracker from "@/components/ApplicationTracker";
import DraftApplication from "@/components/DraftApplication";

type Tab = "scanner" | "tracker" | "draft";

export default function Home() {
  const [tab, setTab] = useState<Tab>("scanner");

  return (
    <div className="flex flex-col flex-1">
      <header className="border-b border-[var(--border)] bg-white/90 backdrop-blur-sm">
        <div className="flex items-center justify-between px-6 py-4">
          <button
            onClick={() => setTab("scanner")}
            className="flex items-center gap-3 text-left transition-opacity hover:opacity-80"
            title="Back to dashboard"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-[var(--accent)] text-white">
              🔥
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--accent)]">
                Burn Manufacturing
              </p>
              <h1 className="font-serif text-lg font-semibold leading-tight text-[var(--ink)]">
                Grant Intelligence
              </h1>
            </div>
          </button>
          <p className="hidden text-xs text-[var(--ink-muted)] sm:block">
            Funding discovery &amp; pipeline tracking
          </p>
        </div>
        <div className="flex gap-1 px-6">
          <TabButton active={tab === "scanner"} onClick={() => setTab("scanner")}>
            🔍 Grant Scanner
          </TabButton>
          <TabButton active={tab === "tracker"} onClick={() => setTab("tracker")}>
            📋 Application Tracker
          </TabButton>
          <TabButton active={tab === "draft"} onClick={() => setTab("draft")}>
            ✍️ Draft Application
          </TabButton>
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
      className={`relative overflow-hidden border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
        active
          ? "border-[var(--accent)] text-[var(--accent)]"
          : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink)]"
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
