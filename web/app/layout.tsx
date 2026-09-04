import type { Metadata } from "next";
import { Fira_Sans, Fira_Code, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import "./globals.css";

import { DENSITY_STORAGE_KEY } from "@/lib/density";

import { CommandPalette } from "./components/command-palette";
import { KeyboardShortcuts } from "./components/keyboard-shortcuts";
import { SiteNav } from "./components/site-nav";

// Applies a returning visitor's saved density preference to <html> before
// first paint, the same "blocking inline script" technique next-themes
// itself uses for the `.dark` class just below — otherwise the page would
// briefly flash comfortable spacing before `initDensity()` (called from a
// client component's effect) runs. Duplicates the storage key as a string
// literal on purpose: this runs outside the React tree, before any module
// evaluates, so it can't import from "@/lib/density" — `DENSITY_STORAGE_KEY`
// is imported above only so the literal below can be templated from the
// same constant and never drift out of sync with it.
const DENSITY_INIT_SCRIPT = `
(function () {
  try {
    var raw = window.localStorage.getItem(${JSON.stringify(DENSITY_STORAGE_KEY)});
    var density = raw ? JSON.parse(raw) : "comfortable";
    if (density !== "compact" && density !== "comfortable") density = "comfortable";
    document.documentElement.setAttribute("data-density", density);
  } catch (e) {
    document.documentElement.setAttribute("data-density", "comfortable");
  }
})();
`;

const firaSans = Fira_Sans({
  variable: "--font-fira-sans",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const firaCode = Fira_Code({
  variable: "--font-fira-code",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

// Team names, game/final scores, and dates use this dedicated mono face
// (distinct from --font-fira-code, the app's general-purpose --font-mono)
// everywhere they appear -- Explorer's Games list and player-search
// results, the game and team detail pages, and BoxScoreTable.
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono-raw",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
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
      className={`${firaSans.variable} ${firaCode.variable} ${jetbrainsMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        {/* Inline (no `src`), so it runs before paint — same rationale as
            next-themes' own script for the `.dark` class. */}
        <script dangerouslySetInnerHTML={{ __html: DENSITY_INIT_SCRIPT }} />
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
