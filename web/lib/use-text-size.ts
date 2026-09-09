"use client";

import { useEffect, useState } from "react";

import {
  getTextSize,
  isTextSize,
  setTextSize,
  TEXT_SIZE_CHANGE_EVENT,
  type TextSize,
} from "@/lib/text-size";

/** React hook for the settings page's text-size control -- reactively
 * reflects changes made elsewhere (another tab, a future keyboard
 * shortcut). Split into its own "use client" file because `useState` and
 * `useEffect` are only available in client code, and `app/layout.tsx`
 * (a Server Component) imports constants from `lib/text-size.ts` directly
 * for the blocking init script — server code can't call hooks or render
 * client components. */
export function useTextSize(): [TextSize, (next: TextSize) => void] {
  const [size, setSizeState] = useState<TextSize>(() => getTextSize());

  useEffect(() => {
    function handleChange(event: Event) {
      const detail = (event as CustomEvent<TextSize>).detail;
      if (isTextSize(detail)) {
        setSizeState(detail);
      }
    }
    window.addEventListener(TEXT_SIZE_CHANGE_EVENT, handleChange);
    return () => window.removeEventListener(TEXT_SIZE_CHANGE_EVENT, handleChange);
  }, []);

  return [size, setTextSize];
}
