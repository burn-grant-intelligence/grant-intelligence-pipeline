"use client";

import { useState } from "react";
import GrantScanner from "@/components/GrantScanner";
import ApplicationTracker from "@/components/ApplicationTracker";

type Tab = "scanner" | "tracker";

export default function Home() {
  const [tab, setTab] = useState<Tab>("scanner");

  return (
    <div className="flex flex-col flex-1">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-orange-600 text-white">
              🔥
            </div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">Grant Intelligence</h1>
              <p className="text-xs text-neutral-500">
                BURN Manufacturing · Daily funding discovery
              </p>
            </div>
          </div>
        </div>
        <div className="mx-auto flex max-w-6xl gap-1 px-6">
          <TabButton active={tab === "scanner"} onClick={() => setTab("scanner")}>
            🔍 Grant Scanner
          </TabButton>
          <TabButton active={tab === "tracker"} onClick={() => setTab("tracker")}>
            📋 Application Tracker
          </TabButton>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        {tab === "scanner" ? <GrantScanner /> : <ApplicationTracker />}
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
      className={`border-b-2 px-3 py-3 text-sm font-medium transition-colors ${
        active
          ? "border-orange-600 text-orange-600"
          : "border-transparent text-neutral-500 hover:text-neutral-800"
      }`}
    >
      {children}
    </button>
  );
}
