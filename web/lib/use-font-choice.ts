"use client";

import { useEffect, useState } from "react";

import {
  FONT_CHOICE_CHANGE_EVENT,
  type FontChoice,
  getFontChoice,
  isFontChoice,
  setFontChoice,
} from "@/lib/font-choice";

/** React hook for the settings page's font picker. Split into its own
 * "use client" file for the same reason as `lib/use-density.ts` -- see
 * `lib/density.ts`'s header. */
export function useFontChoice(): [FontChoice, (next: FontChoice) => void] {
  const [choice, setChoiceState] = useState<FontChoice>(() => getFontChoice());

  useEffect(() => {
    function handleChange(event: Event) {
      const detail = (event as CustomEvent<FontChoice>).detail;
      if (isFontChoice(detail)) {
        setChoiceState(detail);
      }
    }
    window.addEventListener(FONT_CHOICE_CHANGE_EVENT, handleChange);
    return () => window.removeEventListener(FONT_CHOICE_CHANGE_EVENT, handleChange);
  }, []);

  return [choice, setFontChoice];
}
