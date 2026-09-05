import type { Metadata } from "next";
import {
  Barlow_Condensed,
  IBM_Plex_Mono,
  Oswald,
  Rajdhani,
  Russo_One,
  Space_Mono,
  Teko,
} from "next/font/google";
import { ThemeProvider } from "next-themes";
import "./globals.css";

import { DENSITY_STORAGE_KEY } from "@/lib/density";
import {
  BACKGROUND_CHOICE_OPTIONS,
  BACKGROUND_CHOICE_STORAGE_KEY,
  DEFAULT_BACKGROUND_CHOICE,
} from "@/lib/background-choice";
import { DEFAULT_FONT_CHOICE, FONT_CHOICE_OPTIONS, FONT_CHOICE_STORAGE_KEY } from "@/lib/font-choice";
import { DEFAULT_TEXT_SIZE, TEXT_SIZE_STORAGE_KEY } from "@/lib/text-size";

import { CommandPalette } from "./components/command-palette";
import { KeyboardShortcuts } from "./components/keyboard-shortcuts";
import { SiteNav } from "./components/site-nav";

// Applies a returning visitor's saved density, text-size, font, and
// background preferences to <html> before first paint, the same "blocking
// inline script" technique next-themes itself uses for the `.dark` class
// just below — otherwise the page would briefly flash the wrong spacing/
// text size/font/background before the corresponding client component
// effects run. Duplicates the storage keys and defaults as string literals
// on purpose: this runs outside the React tree, before any module
// evaluates, so it can't import from "@/lib/density", "@/lib/text-size",
// "@/lib/font-choice", or "@/lib/background-choice" for the comparisons
// themselves — the constants are imported above only so the literals below
// can be templated from them and never drift out of sync.
const VALID_FONT_CHOICES_JSON = JSON.stringify(
  FONT_CHOICE_OPTIONS.map((option) => option.value)
);
const VALID_BACKGROUND_CHOICES_JSON = JSON.stringify(
  BACKGROUND_CHOICE_OPTIONS.map((option) => option.value)
);

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
  try {
    var rawFont = window.localStorage.getItem(${JSON.stringify(FONT_CHOICE_STORAGE_KEY)});
    var font = rawFont ? JSON.parse(rawFont) : ${JSON.stringify(DEFAULT_FONT_CHOICE)};
    if (${VALID_FONT_CHOICES_JSON}.indexOf(font) === -1) {
      font = ${JSON.stringify(DEFAULT_FONT_CHOICE)};
    }
    document.documentElement.setAttribute("data-font", font);
  } catch (e) {
    document.documentElement.setAttribute("data-font", ${JSON.stringify(DEFAULT_FONT_CHOICE)});
  }
  try {
    var rawBackground = window.localStorage.getItem(${JSON.stringify(BACKGROUND_CHOICE_STORAGE_KEY)});
    var background = rawBackground ? JSON.parse(rawBackground) : ${JSON.stringify(DEFAULT_BACKGROUND_CHOICE)};
    if (${VALID_BACKGROUND_CHOICES_JSON}.indexOf(background) === -1) {
      background = ${JSON.stringify(DEFAULT_BACKGROUND_CHOICE)};
    }
    document.documentElement.setAttribute("data-background", background);
  } catch (e) {
    document.documentElement.setAttribute("data-background", ${JSON.stringify(DEFAULT_BACKGROUND_CHOICE)});
  }
})();
`;

// Every candidate font for the settings page's font picker is loaded here
// (each its own next/font/google instance/CSS variable) so every
// @font-face is always available; globals.css's `[data-font="..."]`
// blocks then point --font-sans/--font-mono/--font-heading/
// --font-geist-mono at whichever one is active (see lib/font-choice.ts).
const teko = Teko({
  variable: "--font-teko-raw",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const oswald = Oswald({
  variable: "--font-oswald-raw",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const barlowCondensed = Barlow_Condensed({
  variable: "--font-barlow-condensed-raw",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const rajdhani = Rajdhani({
  variable: "--font-rajdhani-raw",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const russoOne = Russo_One({
  variable: "--font-russo-one-raw",
  subsets: ["latin"],
  weight: ["400"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono-raw",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const spaceMono = Space_Mono({
  variable: "--font-space-mono-raw",
  subsets: ["latin"],
  weight: ["400", "700"],
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
      className={`${teko.variable} ${oswald.variable} ${barlowCondensed.variable} ${rajdhani.variable} ${russoOne.variable} ${ibmPlexMono.variable} ${spaceMono.variable} h-full antialiased`}
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
