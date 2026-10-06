"use client";

// Tags in text (lib/mentions.ts):
//   <MentionText>     shows text with each tagged person as a coloured tag
//   <MentionTextarea> a text box that colours names as you type and suggests
//                     team members (type "@" or the start of a first name;
//                     ↑/↓ to pick, Enter or Tab to insert, Esc to close)

import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { applyMention, mentionOptions, mentionQuery, segments, tagColor, type MentionQuery } from "@/lib/mentions";

export function MentionText({ text, className }: { text: string | null | undefined; className?: string }) {
  return (
    <span className={className}>
      {segments(text).map((s, i) =>
        s.person ? (
          <span
            key={i}
            title={s.person === "Everyone" ? "Tagged: the whole team" : `Tagged: ${s.person}`}
            style={tagColor(s.person)}
            className="whitespace-nowrap rounded-full px-1.5 py-px font-medium"
          >
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        )
      )}
    </span>
  );
}

// Text box and highlight layer must use exactly the same box and font so the
// coloured tags sit under the words.
const BOX = "w-full rounded-md border px-2.5 py-1.5 text-sm leading-5";

export function MentionTextarea({
  value,
  onChange,
  placeholder,
  minRows = 3,
  ariaLabel,
  hint = true,
  onSubmit,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  minRows?: number;
  ariaLabel?: string;
  hint?: boolean;
  /** Ctrl/⌘ + Enter */
  onSubmit?: () => void;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const backRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);
  const options = query ? mentionOptions(query) : [];

  // Grow with the text (so the highlight layer never has to scroll).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);

  function readQuery(el: HTMLTextAreaElement) {
    const caret = el.selectionStart ?? el.value.length;
    if (el.selectionEnd !== caret) return setQuery(null);
    setQuery(mentionQuery(el.value.slice(0, caret)));
    setActive(0);
  }

  function choose(i: number) {
    const el = ref.current;
    const opt = options[i];
    if (!el || !opt || !query) return;
    const res = applyMention(value, el.selectionStart ?? value.length, query, opt);
    onChange(res.text);
    setQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(res.caret, res.caret);
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (options.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        return setActive((a) => (a + 1) % options.length);
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        return setActive((a) => (a - 1 + options.length) % options.length);
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        return choose(active);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        return setQuery(null);
      }
    }
    if (onSubmit && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit();
    }
  }

  return (
    <div className="relative w-full">
      <div className="relative rounded-md bg-white">
        <div
          ref={backRef}
          aria-hidden
          className={`${BOX} pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words border-transparent text-transparent`}
        >
          {segments(value).map((s, i) =>
            s.person ? (
              <mark key={i} style={{ background: tagColor(s.person).background, color: "transparent", borderRadius: 9999, boxShadow: `0 0 0 2px ${tagColor(s.person).background}` }}>
                {s.text}
              </mark>
            ) : (
              <span key={i}>{s.text}</span>
            )
          )}
          {"​"}
        </div>
        <textarea
          ref={ref}
          value={value}
          rows={minRows}
          autoFocus={autoFocus}
          aria-label={ariaLabel ?? placeholder}
          aria-autocomplete="list"
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value);
            readQuery(e.target);
          }}
          onKeyDown={onKeyDown}
          onClick={(e) => readQuery(e.currentTarget)}
          onBlur={() => setTimeout(() => setQuery(null), 150)}
          onScroll={(e) => {
            if (backRef.current) backRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
          className={`${BOX} relative block resize-none overflow-hidden border-neutral-200 bg-transparent text-neutral-800 focus:border-[var(--accent)] focus:outline-none`}
        />
      </div>
      {options.length > 0 && (
        <ul role="listbox" aria-label="Tag someone" className="absolute left-0 top-full z-30 mt-1 w-72 overflow-hidden rounded-md border border-neutral-200 bg-white py-1 shadow-lg">
          {options.map((o, i) => (
            <li
              key={o.person}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(i);
              }}
              onMouseEnter={() => setActive(i)}
              className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm ${i === active ? "bg-neutral-100" : ""}`}
            >
              <span style={tagColor(o.person)} className="rounded-full px-2 py-0.5 text-xs font-semibold">
                {o.insert.replace(/^@/, "")}
              </span>
              <span className="text-neutral-600">{o.label}</span>
            </li>
          ))}
        </ul>
      )}
      {hint && <p className="mt-1 text-[11px] text-neutral-400">Type a name to tag someone (e.g. Hussein) · @Everyone tags the whole team</p>}
    </div>
  );
}
