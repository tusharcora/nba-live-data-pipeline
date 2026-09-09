import type { Metadata } from "next";
import { Bebas_Neue, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { DEFAULT_TEXT_SIZE, TEXT_SIZE_STORAGE_KEY } from "@/lib/text-size";

import { CommandPalette } from "./components/command-palette";
import { KeyboardShortcuts } from "./components/keyboard-shortcuts";

// Applies a returning visitor's saved text-size preference to <html>
// before first paint -- a blocking inline script, so it runs before the
// corresponding client component effect and there's no flash of the
// wrong text size. Duplicates the storage key and default as a string
// literal on purpose: this runs outside the React tree, before any
// module evaluates, so it can't import from "@/lib/text-size" for the
// comparison itself -- the constant is imported above only so the
// literal below can be templated from it and never drift out of sync.
//
// This used to also apply density/font/background preferences (removed
// in the v2 UI rework -- one fixed dark theme, fixed fonts, fixed
// density; see
// docs/superpowers/specs/2026-09-09-ui-rework-trading-terminal-design.md).
// Text-size stays: it's a genuine accessibility control, not a
// look-and-feel pick.
const TEXT_SIZE_INIT_SCRIPT = `
(function () {
  try {
    var rawTextSize = window.localStorage.getItem(${JSON.stringify(TEXT_SIZE_STORAGE_KEY)});
    var textSize = rawTextSize ? JSON.parse(rawTextSize) : ${JSON.stringify(DEFAULT_TEXT_SIZE)};
    if (textSize !== "normal" && textSize !== "large" && textSize !== "larger") {
      textSize = ${JSON.stringify(DEFAULT_TEXT_SIZE)};
    }
    document.documentElement.setAttribute("data-text-size", textSize);
  } catch (e) {
    document.documentElement.setAttribute("data-text-size", ${JSON.stringify(DEFAULT_TEXT_SIZE)});
  }
})();
`;

// Fixed brand wordmark face (SiteHeader's "Box"/"score.gg") -- doesn't
// follow any picker, the same way the wordmark's colors are fixed
// regardless of theme.
const bebasNeue = Bebas_Neue({
  variable: "--font-bebas-neue-raw",
  subsets: ["latin"],
  weight: ["400"],
});

// Fixed UI/body/heading face across the whole app (v2 UI rework --
// restrained, technical, the Greptile half of the design anchor). Weight
// 300 covers the brand tagline next to the wordmark; 400/500/600 cover
// body copy, labels, and headings.
const geist = Geist({
  variable: "--font-geist-raw",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

// Fixed numeric face across the whole app -- scores, stats, timestamps,
// percentages, KPI values (v2 UI rework -- the Kalshi/Polymarket half of
// the design anchor). A genuine monospace face, so tabular/fixed-width
// digits are guaranteed by construction: this is what makes ticking-
// number score transitions not jitter, unlike the old `--font-active-raw`
// indirection, which pointed `--font-mono` at whichever *display* font
// (Teko/Oswald/Barlow Condensed/etc.) the removed font-choice picker had
// selected -- none of which were actually monospace.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono-raw",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Boxscore",
  description:
    "An NBA data pipeline showcasing ingestion, source reconciliation, and drift monitoring.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      // "dark" is unconditional, not a default -- this app has a single
      // fixed dark theme and no light-mode opt-out (v2 UI rework; see the
      // design spec's PRD amendment).
      className={`dark ${bebasNeue.variable} ${geist.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        {/* Inline (no `src`), so it runs before paint and there's no
            flash of the wrong text size. */}
        <script dangerouslySetInnerHTML={{ __html: TEXT_SIZE_INIT_SCRIPT }} />
        <CommandPalette />
        {children}
        <KeyboardShortcuts />
      </body>
    </html>
  );
}
