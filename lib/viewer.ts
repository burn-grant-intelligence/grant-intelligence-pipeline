"use client";

// "Viewing as" — who is using the app on this browser (there are no logins).
// Shared by the Application Tracker, Draft Application and the header bell,
// so picking your name in one place applies everywhere, including other tabs.
// Same storage key the tabs used before, so nobody has to pick again.

import { useSyncExternalStore } from "react";
import { canonicalLead } from "./pipeline";

const VIEWER_KEY = "grant-intelligence.viewer";
const VIEWER_EVENT = "grant-intelligence-viewer";
let viewerFallback: string | null = null; // when browser storage is blocked

function readViewer(): string | null {
  try {
    return canonicalLead(window.localStorage.getItem(VIEWER_KEY)) ?? viewerFallback;
  } catch {
    return viewerFallback;
  }
}

export function setViewer(value: string | null) {
  viewerFallback = value;
  try {
    if (value) window.localStorage.setItem(VIEWER_KEY, value);
    else window.localStorage.removeItem(VIEWER_KEY);
  } catch {
    // private browsing etc. — kept for this visit only
  }
  window.dispatchEvent(new Event(VIEWER_EVENT));
}

function subscribe(cb: () => void) {
  window.addEventListener("storage", cb);
  window.addEventListener(VIEWER_EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(VIEWER_EVENT, cb);
  };
}

export function useViewer(): string | null {
  return useSyncExternalStore(subscribe, readViewer, () => null);
}
