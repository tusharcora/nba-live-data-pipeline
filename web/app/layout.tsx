import type { Metadata } from "next";
import { Teko } from "next/font/google";
import { ThemeProvider } from "next-themes";
import "./globals.css";

import { DENSITY_STORAGE_KEY } from "@/lib/density";
import { DEFAULT_TEXT_SIZE, TEXT_SIZE_STORAGE_KEY } from "@/lib/text-size";

import { CommandPalette } from "./components/command-palette";
import { KeyboardShortcuts } from "./components/keyboard-shortcuts";
import { SiteNav } from "./components/site-nav";

// Applies a returning visitor's saved density and text-size preferences to
// <html> before first paint, the same "blocking inline script" technique
// next-themes itself uses for the `.dark` class just below — otherwise the
// page would briefly flash comfortable spacing / default text size before
// the corresponding client component effects run. Duplicates the storage
// keys and defaults as string literals on purpose: this runs outside the
// React tree, before any module evaluates, so it can't import from
// "@/lib/density" or "@/lib/text-size" for the comparisons themselves —
// the constants are imported above only so the literals below can be
// templated from them and never drift out of sync.
const PREFERENCES_INIT_SCRIPT = `
(function () {
  try {
    var raw = window.localStorage.getItem(${JSON.stringify(DENSITY_STORAGE_KEY)});
    var density = raw ? JSON.parse(raw) : "comfortable";
    if (density !== "compact" && density !== "comfortable") density = "comfortable";
    document.documentElement.setAttribute("data-density", density);
  } catch (e) {
    document.documentElement.setAttribute("data-density", "comfortable");
  }
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

// Every font token this app defines (--font-sans, --font-mono,
// --font-heading, --font-geist-mono) maps to this single family in
// globals.css's @theme block -- one font, applied everywhere, rather than
// the previous three-typeface system (Fira Sans / Fira Code / Geist Mono).
const teko = Teko({
  variable: "--font-teko-raw",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Boxscore.gg",
  description:
    "An NBA data pipeline showcasing ingestion, source reconciliation, and drift monitoring.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${teko.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        {/* Inline (no `src`), so it runs before paint — same rationale as
            next-themes' own script for the `.dark` class. */}
        <script dangerouslySetInnerHTML={{ __html: PREFERENCES_INIT_SCRIPT }} />
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <SiteNav />
          <CommandPalette />
          {children}
          <KeyboardShortcuts />
        </ThemeProvider>
      </body>
    </html>
  );
}
