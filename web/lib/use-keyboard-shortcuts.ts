"use client";

/**
 * GitHub-style sequential (`g` then a letter) navigation shortcuts, plus a
 * `?` shortcut that opens a shortcuts-help overlay.
 *
 * This is a hook (not a plain component) because its job is stateful event
 * wiring — a document-level keydown listener, a short-lived "waiting for
 * the second key of a `g x` sequence" timer, and the help-overlay open
 * state — none of which needs to render anything itself. The actual overlay
 * markup lives in `web/app/components/keyboard-shortcuts.tsx`, which calls
 * this hook and renders the dialog; that component is the one thing
 * `web/app/layout.tsx` mounts. Splitting it this way keeps the guard logic
 * (`isTypingTarget`) and the shortcut table (`SEQUENTIAL_SHORTCUTS`) in a
 * plain, dependency-light module that's easy to read/inspect in isolation
 * without also reading the dialog JSX.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export interface SequentialShortcut {
  /** Second key of the `g` sequence, e.g. "l" for `g l`. */
  key: string;
  href: string;
  label: string;
}

/** Single source of truth for both the routing table and the help overlay. */
export const SEQUENTIAL_SHORTCUTS: SequentialShortcut[] = [
  { key: "l", href: "/live", label: "Live Board" },
  { key: "q", href: "/quality", label: "Data Quality Scorecard" },
  { key: "e", href: "/explorer", label: "Historical Explorer" },
  { key: "h", href: "/", label: "Home" },
];

/** How long (ms) a leading `g` stays "armed" while waiting for the next key. */
const SEQUENCE_TIMEOUT_MS = 900;

/**
 * The input-focus guard. Every shortcut handler in this project must call
 * this before acting on a keystroke.
 *
 * Returns true when the given element is a text input, a textarea, a
 * `contenteditable` region, or a `<select>` — i.e. anywhere a keystroke is
 * meant to produce text or change a form value rather than trigger a
 * global shortcut. This is what keeps `g`/`l`/`q`/`e`/`h`/`?` from hijacking
 * Explorer's real player-name search `<Input>` (`web/app/explorer/page.tsx`)
 * or a sibling task's saved-search-label input.
 *
 * Deliberately checks the *live* `document.activeElement` at keydown time
 * (not a ref captured once) so it stays correct as focus moves around the
 * page, and walks up via `closest()` so a styled `<span>`/`<div>` nested
 * inside a `contenteditable` root is still caught even when the element
 * that has literal focus is the contenteditable root's descendant.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }

  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    // Checkboxes/radios/buttons/ranges etc. don't consume text keystrokes,
    // so shortcuts should still work while one of those happens to be
    // focused (e.g. tabbing through a filter's checkboxes).
    const nonTextInputTypes = new Set([
      "checkbox",
      "radio",
      "button",
      "submit",
      "reset",
      "range",
      "color",
      "file",
    ]);
    return !nonTextInputTypes.has(type);
  }

  if (target instanceof HTMLElement && target.isContentEditable) {
    return true;
  }

  // Covers the case where the focused node is a child of a
  // contenteditable root (e.g. a caret inside a nested <span>).
  return target.closest('[contenteditable="true"]') !== null;
}

function hasModifierKey(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey;
}

/**
 * Wires up the sequential-navigation and help-overlay shortcuts. Returns
 * `[helpOpen, setHelpOpen]` so a single overlay component can be both
 * driven by the `?` key and closable by its own UI (Escape / close button).
 */
export function useKeyboardShortcuts(): [
  boolean,
  (open: boolean) => void,
] {
  const router = useRouter();
  const [helpOpen, setHelpOpen] = useState(false);
  const pendingPrefixRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function clearPendingPrefix() {
      pendingPrefixRef.current = false;
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      // Guard #1 (Global Constraint, stated twice deliberately): never act
      // on a keystroke while focus is inside a text input, textarea, or
      // contenteditable element.
      if (isTypingTarget(event.target)) {
        return;
      }

      if (hasModifierKey(event)) {
        return;
      }

      // While the help overlay is open, let it own the keyboard (its own
      // Escape-to-close handling comes from the base-ui Dialog primitive).
      // Only `?` is allowed through, so it can also toggle the overlay
      // closed.
      if (helpOpen && event.key !== "?") {
        return;
      }

      if (event.key === "?") {
        event.preventDefault();
        clearPendingPrefix();
        setHelpOpen((open) => !open);
        return;
      }

      if (pendingPrefixRef.current) {
        clearPendingPrefix();
        const match = SEQUENTIAL_SHORTCUTS.find((s) => s.key === event.key);
        if (match) {
          event.preventDefault();
          router.push(match.href);
        }
        return;
      }

      if (event.key === "g") {
        pendingPrefixRef.current = true;
        timeoutRef.current = setTimeout(clearPendingPrefix, SEQUENCE_TIMEOUT_MS);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      clearPendingPrefix();
    };
  }, [router, helpOpen]);

  return [helpOpen, setHelpOpen];
}
