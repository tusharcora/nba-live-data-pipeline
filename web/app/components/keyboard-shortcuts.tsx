"use client";

import { Dialog } from "@base-ui/react/dialog";

import { cn } from "@/lib/utils";
import { SEQUENTIAL_SHORTCUTS, useKeyboardShortcuts } from "@/lib/use-keyboard-shortcuts";

import { FOCUS_RING } from "./site-nav";

const KBD_CLASS =
  "inline-flex min-w-6 items-center justify-center rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-xs font-medium text-foreground";

/**
 * Mounted once in `web/app/layout.tsx`. Renders nothing visible by default;
 * owns the document-level keydown listener (via `useKeyboardShortcuts`) and
 * the `?` shortcuts-help overlay.
 */
export function KeyboardShortcuts() {
  const [open, setOpen] = useKeyboardShortcuts();

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-popover p-6 text-popover-foreground shadow-lg">
          <Dialog.Title className="font-heading text-base font-semibold">
            Keyboard shortcuts
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted-foreground">
            Ignored while typing in a text field. Press Escape to close.
          </Dialog.Description>

          <ul className="mt-4 flex flex-col gap-2 text-sm">
            {SEQUENTIAL_SHORTCUTS.map((shortcut) => (
              <li key={shortcut.href} className="flex items-center justify-between gap-4">
                <span>{shortcut.label}</span>
                <span className="flex items-center gap-1">
                  <kbd className={KBD_CLASS}>g</kbd>
                  <kbd className={KBD_CLASS}>{shortcut.key}</kbd>
                </span>
              </li>
            ))}
            <li className="flex items-center justify-between gap-4 border-t border-border pt-2">
              <span>Show this help</span>
              <kbd className={KBD_CLASS}>?</kbd>
            </li>
          </ul>

          <Dialog.Close
            className={cn(
              "mt-5 inline-flex h-8 cursor-pointer items-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors duration-200 hover:bg-muted",
              FOCUS_RING
            )}
          >
            Close
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default KeyboardShortcuts;
