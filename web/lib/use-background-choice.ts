"use client";

import { useEffect, useState } from "react";

import {
  BACKGROUND_CHOICE_CHANGE_EVENT,
  type BackgroundChoice,
  getBackgroundChoice,
  isBackgroundChoice,
  setBackgroundChoice,
} from "@/lib/background-choice";

/** React hook for the settings page's background picker. Split into its
 * own "use client" file for the same reason as `lib/use-density.ts` --
 * see `lib/density.ts`'s header. */
export function useBackgroundChoice(): [BackgroundChoice, (next: BackgroundChoice) => void] {
  const [choice, setChoiceState] = useState<BackgroundChoice>(() => getBackgroundChoice());

  useEffect(() => {
    function handleChange(event: Event) {
      const detail = (event as CustomEvent<BackgroundChoice>).detail;
      if (isBackgroundChoice(detail)) {
        setChoiceState(detail);
      }
    }
    window.addEventListener(BACKGROUND_CHOICE_CHANGE_EVENT, handleChange);
    return () => window.removeEventListener(BACKGROUND_CHOICE_CHANGE_EVENT, handleChange);
  }, []);

  return [choice, setBackgroundChoice];
}
