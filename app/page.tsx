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
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 pt-5 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--accent-soft)] text-lg">
              🔥
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
                BURN Manufacturing
              </p>
              <h1 className="font-serif-display text-2xl leading-tight tracking-tight text-[var(--ink)]">
                Grant Intelligence
              </h1>
            </div>
          </div>
          <p className="hidden text-xs text-[var(--ink-muted)] sm:block">
            Funding discovery &amp; pipeline tracking
          </p>
        </div>
        <div className="mx-auto flex max-w-6xl px-6">
          <TabButton active={tab === "scanner"} onClick={() => setTab("scanner")}>
            Grant Scanner
          </TabButton>
          <TabButton active={tab === "tracker"} onClick={() => setTab("tracker")}>
            Application Tracker
          </TabButton>
          <TabButton active={tab === "draft"} onClick={() => setTab("draft")}>
            Draft Application
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
  return (
    <button
      onClick={onClick}
      className={`mr-6 border-b-2 px-1 py-3 text-sm font-medium tracking-wide transition-colors ${
        active
          ? "border-[var(--accent)] text-[var(--accent)]"
          : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink)]"
      }`}
    >
      {children}
    </button>
  );
}
