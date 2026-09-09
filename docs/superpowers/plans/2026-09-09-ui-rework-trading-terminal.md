# v2 UI Rework (Trading-Terminal Design) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `web/` app's shadcn/ui + sports-broadcast look (7-font/4-background/2-density runtime picker) with one fixed, deliberate dark theme in a Greptile/Kalshi/Polymarket-inspired trading-terminal style, reskinning existing primitives rather than rebuilding them.

**Architecture:** One token-layer pass (`app/globals.css` + `app/layout.tsx`'s fonts) that cascades the new look through every existing page automatically, since most components already read `font-mono`/`text-muted-foreground`/`border-border`/`bg-card`/etc. rather than hardcoded values. On top of that: remove the runtime font/background/density picker (settings, command palette, layout init script, and the `lib/*-choice.ts` modules themselves), add one new semantic color (`success`, paired with green for data-quality "added"/pass states), and extract two small shared presentational components (`LivePulse`, `StatTile`) from patterns that already exist inline in `LiveBoard.tsx` and `quality-section.tsx`.

**Tech Stack:** Next.js (App Router), Tailwind v4 (`@theme inline` tokens in `app/globals.css`), shadcn/ui + Radix primitives, `next/font/google`, Vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-09-09-ui-rework-trading-terminal-design.md`

## Deviations from the spec (read before Task 1)

Two places where this plan does less than the spec's literal wording, both judgment calls made during research rather than oversights:

- **"`/` leads with the live product"**: already true today. `app/page.tsx` renders `<SiteHeader>` then `<RecentGamesBoard>` immediately, with the pipeline-description copy in a `<footer>` *below* the board, not above it. No task changes `app/page.tsx` — there's nothing to fix. Confirmed explicitly in Task 9's browser walkthrough rather than left as an assumption.
- **"Market-card: a variant of the existing game-row component with live score, delta indicator, and monospace numerics"**: no new component is built for this. `RecentGamesBoard`'s existing board rows and "feed ticket" panel already implement the market-card concept (card treatment, mono `tabular-nums` scores, amber "Final" tag) — Task 1/2's token cascade is what reskins them, no structural change needed. The "delta/momentum indicator" part is deliberately **not** built: there's no real data source for it today (a completed historical game has no period-over-period score history to diff, and `/live`'s SSE payload doesn't carry it either) — inventing one would mean fabricating a number, which contradicts this codebase's own documented stance elsewhere (`RecentGamesBoard`'s header comment explicitly rejects faking a "LIVE" pill for historical games rather than showing something not real). If real momentum data becomes available later, add it then, as its own task against real data.
- **"A brief transition on score changes" (spec's Motion section)**: not implemented. This gap was found by the final whole-branch review, not by any per-task review — no task in this plan ever covered it, which is itself the defect (a plan-authoring gap, not an implementation one). Ruled to document rather than implement blind: this environment has no live backend (Task 9's verification pass confirmed FastAPI/Postgres aren't running here), so a score-change animation could not be visually verified against a real, changing score — shipping unverified motion behavior would be worse than an honest documented gap, consistent with this codebase's own repeated stance (see the live-pulse dot above, and `RecentGamesBoard`'s refusal to fake liveness). If this is picked up later, it should be its own task, built and verified against a real live game.

## Global Constraints

- Single fixed dark theme — no light theme, no runtime font/background/density picker. (Spec: "Theme"; PRD amendment in `docs/prd.md` §11.)
- WCAG AA contrast (4.5:1 body text, 3:1 UI components/large text) and colorblind-safe semantic color (always paired with an icon or text label, never color alone) — unchanged requirement, carried into every new/changed color. (Spec: "Color"; PRD §11, unchanged.)
- No framer-motion or other new animation dependency — motion is plain CSS (`@keyframes`/`transition`/Tailwind's `animate-*` utilities), matching the existing `ticker-scroll` keyframe and `motion-safe:`/`motion-reduce:` usage already in this codebase.
- No backend/API changes — `web/` only.
- Reskin existing shadcn/Radix primitives; do not rebuild them from scratch.
- `/settings`'s "Your data" reset controls (favorite teams, saved searches) are functional and must be kept working, unchanged.
- This codebase verifies presentational/visual components (e.g. `LiveBoard`, `RecentGamesBoard`, `quality-section`) via `npx tsc --noEmit` + `npm run lint` + a real browser walkthrough, not React-render unit tests — there are zero `*.test.tsx` files for any component in this category today. Follow that existing convention for every task below rather than introducing a new, inconsistent testing pattern; only `lib/` logic (untouched by this plan) gets Vitest unit tests in this codebase.
- Every task's file edits are exact, verbatim replacements of code read directly from the current worktree (branch `worktree-v2-ui-rework`, based on `main`, which already includes the merged v2-sportsbook-redesign work) — if a task's "old" text doesn't match what's on disk when you reach it, stop and re-read the file before proceeding; don't guess.

---

## Task 1: Token layer — single fixed dark theme, sharper radius, `success` semantic

**Files:**
- Modify: `web/app/globals.css` (full-file replacement)

**Interfaces:**
- Produces: CSS custom properties `--success` (hex `#22c55e`, matches existing `--chart-1`) and `--color-success` (Tailwind theme token, enables `bg-success`/`text-success`/`border-success` utilities) — consumed by Task 6 (badge variant) and Task 8 (StatTile, indirectly via existing `--chart-1`-adjacent usage). Produces fixed `--font-sans`/`--font-mono`/`--font-heading`/`--font-geist-mono` theme tokens pointing at `--font-geist-raw`/`--font-geist-mono-raw` — consumed by Task 2, which defines those two raw variables.
- Removes: `--font-active-raw`, all `:root[data-font="..."]` blocks, all `.dark[data-background="..."]` blocks, `:root[data-density="compact"]`. Nothing later in this plan reads any of these.

Contrast math for the two values below (relative-luminance / WCAG formula), so the numbers in the file's comment are verifiable, not asserted: `--success` (#22c55e) against `--card` (#161616) computes to ~7.9:1, and against `--background` (#0a0a0a) to ~8.7:1 — both clear the 4.5:1 body-text AA bar with margin. `--destructive` (#f87171) against `--card` was already measured at 4.16:1 by this codebase's own prior contrast pass (see the comment this task replaces) — that clears the 3:1 UI-component/large-text bar but not the 4.5:1 body-text bar, so it must keep being paired with an icon/label (already true everywhere it's used) and avoided for small plain-text sentences.

- [ ] **Step 1: Replace `app/globals.css` with the following complete content**

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";

@custom-variant dark (&:is(.dark *));

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --font-sans: var(--font-geist-raw);
  --font-mono: var(--font-geist-mono-raw);
  --font-heading: var(--font-geist-raw);
  --font-geist-mono: var(--font-geist-mono-raw);
  --color-sidebar-ring: var(--sidebar-ring);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar: var(--sidebar);
  --color-chart-5: var(--chart-5);
  --color-chart-4: var(--chart-4);
  --color-chart-3: var(--chart-3);
  --color-chart-2: var(--chart-2);
  --color-chart-1: var(--chart-1);
  --color-ring: var(--ring);
  --color-input: var(--input);
  --color-border: var(--border);
  --color-destructive: var(--destructive);
  --color-success: var(--success);
  --color-accent-foreground: var(--accent-foreground);
  --color-accent: var(--accent);
  --color-muted-foreground: var(--muted-foreground);
  --color-muted: var(--muted);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-secondary: var(--secondary);
  --color-primary-foreground: var(--primary-foreground);
  --color-primary: var(--primary);
  --color-popover-foreground: var(--popover-foreground);
  --color-popover: var(--popover);
  --color-card-foreground: var(--card-foreground);
  --color-card: var(--card);
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
  --radius-2xl: calc(var(--radius) * 1.8);
  --radius-3xl: calc(var(--radius) * 2.2);
  --radius-4xl: calc(var(--radius) * 2.6);
}

/* v2 UI rework: a single fixed dark theme, no light theme and no runtime
   palette/font/density picker -- see
   docs/superpowers/specs/2026-09-09-ui-rework-trading-terminal-design.md
   and the PRD amendment in docs/prd.md §11. `.dark` (below) is
   unconditionally applied to <html> in app/layout.tsx. `--radius` is set
   sharper than the old default (was 0.625rem) to read more "trading
   terminal," less "consumer app." */
:root {
  --radius: 0.375rem;
}

.dark {
  /* Single fixed dark theme (formerly the "Charcoal" option among four
     data-background alternates -- Slate/Graphite/Espresso removed; see
     git history). Values are unchanged from Charcoal, which was already
     this app's default. --primary/--primary-foreground/--destructive/
     --ring are the palette's load-bearing accent decisions:
     primary-foreground uses on-accent navy (#1a1006) rather than white
     (avoids under-contrasting against the amber primary); destructive is
     Tailwind red-400 (#F87171), measured at 4.16:1 against --card --
     clears the 3:1 UI-component/large-text bar but not 4.5:1 body-text,
     so it must stay paired with an icon/label (colorblind-safe) and
     avoided for small plain-text sentences. --success reuses --chart-1's
     green (#22c55e): measured at ~7.9:1 against --card and ~8.7:1
     against --background, comfortably clearing the 4.5:1 body-text bar
     in both cases. */
  --background: #0a0a0a;
  --foreground: #f5f5f4;
  --card: #161616;
  --card-foreground: #f5f5f4;
  --popover: #161616;
  --popover-foreground: #f5f5f4;
  --primary: #f59e0b;
  --primary-foreground: #1a1006;
  --secondary: #2e2e2e;
  --secondary-foreground: #ffffff;
  --muted: #232323;
  --muted-foreground: #a3a3a1;
  --accent: #2e2e2e;
  --accent-foreground: #ffffff;
  --destructive: #f87171;
  --success: #22c55e;
  --border: #3d3d3d;
  --input: #3d3d3d;
  --ring: #ffffff;
  --chart-1: #22c55e;
  --chart-2: #38bdf8;
  --chart-3: #f59e0b;
  --chart-4: #f87171;
  --chart-5: #94a3b8;
  --sidebar: var(--card);
  --sidebar-foreground: var(--card-foreground);
  --sidebar-primary: var(--primary);
  --sidebar-primary-foreground: var(--primary-foreground);
  --sidebar-accent: var(--accent);
  --sidebar-accent-foreground: var(--accent-foreground);
  --sidebar-border: var(--border);
  --sidebar-ring: var(--ring);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
  html {
    @apply font-sans;
  }
}

/*
 * Global prefers-reduced-motion guard (MASTER.md pre-delivery checklist).
 * Belt-and-suspenders alongside per-utility `motion-safe:` variants used at
 * call sites: this also neutralizes animations that don't opt in per-class,
 * such as shadcn's Skeleton (`animate-pulse`), for anyone with the OS-level
 * reduced-motion preference set. Final visual states still render — only
 * the transition/animation timing collapses to effectively instant.
 */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}

/*
 * Fixed compact-density spacing tokens. Formerly a comfortable/compact
 * toggle driven by `lib/density.ts` (removed in the v2 UI rework -- see
 * the design spec); the compact values are now the single, permanent
 * default, matching a trading terminal's tighter row heights over the
 * old "comfortable" default.
 *
 * Deliberately UNLAYERED (not inside any `@layer` block): Tailwind puts
 * every utility class it generates -- including the Card component's own
 * `[--card-spacing:--spacing(4)]` arbitrary-property utility and the
 * Table component's `h-10`/`px-2`/`p-2` utilities in
 * `web/components/ui/{card,table}.tsx` -- inside `@layer utilities`. Per
 * the CSS cascade-layers spec, ANY unlayered rule beats ANY layered rule
 * regardless of selector specificity or source order, so a plain
 * (unlayered) `[data-slot="..."]` rule here can override those utilities
 * without editing card.tsx/table.tsx or fighting specificity with
 * `!important`.
 */
:root {
  --density-card-spacing: --spacing(2.5);
  --density-table-cell-py: --spacing(1);
  --density-table-head-h: --spacing(8);
}

[data-slot="card"] {
  --card-spacing: var(--density-card-spacing);
}

[data-slot="table-cell"] {
  padding-block: var(--density-table-cell-py);
}

[data-slot="table-head"] {
  height: var(--density-table-head-h);
}

/*
 * Text-size preference (normal/large/larger), driven by
 * `web/lib/text-size.ts` -- kept from the pre-rework design as a genuine
 * accessibility control, distinct from the removed look-and-feel pickers.
 * Toggling it sets `data-text-size="normal" | "large" | "larger"` on
 * `<html>` (see `web/app/layout.tsx`'s inline init script), which this
 * block reads to scale a `--text-scale` multiplier.
 *
 * Rather than introducing new tokens the way the density section above
 * does, this redefines Tailwind's OWN `--text-xs`/`--text-sm`/etc. theme
 * variables in terms of that multiplier -- every `text-*` utility class
 * Tailwind generates already reads its font-size from exactly these
 * variables, so overriding them here rescales all typography app-wide
 * with no per-component changes. Deliberately UNLAYERED, same rationale
 * as the density section above.
 *
 * Default multiplier is 1.125 (the "large" tier), not 1 -- this app's
 * baseline text size is a step up from stock Tailwind sizing by design;
 * "normal" (1) is offered as an opt-out on the settings page.
 */
:root {
  --text-scale: 1.125;
  --text-xs: calc(0.75rem * var(--text-scale));
  --text-sm: calc(0.875rem * var(--text-scale));
  --text-base: calc(1rem * var(--text-scale));
  --text-lg: calc(1.125rem * var(--text-scale));
  --text-xl: calc(1.25rem * var(--text-scale));
  --text-2xl: calc(1.5rem * var(--text-scale));
  --text-3xl: calc(1.875rem * var(--text-scale));
  --text-4xl: calc(2.25rem * var(--text-scale));
}

:root[data-text-size="normal"] {
  --text-scale: 1;
}

:root[data-text-size="larger"] {
  --text-scale: 1.25;
}

/* Homepage recent-games ticker (app/components/recent-games-board.tsx) --
   a plain, named keyframe rather than an arbitrary inline animation value,
   since the scroll distance (-50%, exactly half of a list duplicated once
   for a seamless loop) needs to live somewhere referenceable. */
@keyframes ticker-scroll {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(-50%);
  }
}
```

- [ ] **Step 2: Confirm the app still builds (font tokens aren't wired up yet — that's Task 2)**

Run: `npx tsc --noEmit` from `web/`
Expected: unrelated to this CSS-only file, so no new TypeScript errors. (The app will render with fallback fonts until Task 2 defines `--font-geist-raw`/`--font-geist-mono-raw` — that's expected and fixed next task, not a bug to chase now.)

- [ ] **Step 3: Commit**

```bash
git add web/app/globals.css
git commit -m "feat(web): single fixed dark theme, sharper radius, success token"
```

---

## Task 2: Fonts — fixed Geist Sans + Geist Mono, drop the font/background/density picker's init script

**Files:**
- Modify: `web/app/layout.tsx` (full-file replacement)
- Modify: `web/app/components/site-header.tsx:87` (stale comment only)

**Interfaces:**
- Produces: `--font-geist-raw` (Geist Sans, weights 300/400/500/600) and `--font-geist-mono-raw` (Geist Mono, weights 400/500/600/700) CSS variables on `<html>` — consumed by Task 1's `@theme inline` block (already written, was pointing at these two names in anticipation).
- Removes: the `DENSITY_STORAGE_KEY`/`BACKGROUND_CHOICE_*`/`FONT_CHOICE_*` imports and the corresponding blocks of the blocking init script. Task 3 (command palette) and Task 4 (settings) still reference `lib/density.ts`/`lib/background-choice.ts`/`lib/font-choice.ts` at this point — that's fine, this task only removes `layout.tsx`'s own references; those modules aren't deleted until Task 5.

- [ ] **Step 1: Replace `app/layout.tsx` with the following complete content**

```tsx
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
  weight: ["300", "400", "500", "600"],
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
```

- [ ] **Step 2: Fix the stale font-choice comment in `site-header.tsx`**

In `web/app/components/site-header.tsx`, find this line (inside the wordmark `<h1>`'s surrounding comment, around line 87):

```
              user's font-choice setting, the same way a real product's
```

Replace with:

```
              real product's own logotype doesn't follow a design system's
```

(Read the full surrounding sentence first — it originally read "...Fixed brand wordmark -- always Bebas Neue regardless of the user's font-choice setting, the same way a real product's logotype doesn't follow a reader's font preference." Rewrite that whole sentence to remove the now-nonexistent "font-choice setting"/"reader's font preference" — for example: "Fixed brand wordmark -- always Bebas Neue, the same way a real product's logotype doesn't follow the rest of the page's type system." Apply as a single coherent edit, not a literal fragment substitution.)

- [ ] **Step 3: Verify the app builds and fonts resolve**

Run: `npx tsc --noEmit && npm run lint` from `web/`
Expected: no errors. `next/font/google`'s `Geist`/`Geist_Mono`/`Bebas_Neue` imports are valid (Geist was already imported from this same package before this change).

- [ ] **Step 4: Commit**

```bash
git add web/app/layout.tsx web/app/components/site-header.tsx
git commit -m "feat(web): fix Geist Sans/Geist Mono as the app's only fonts"
```

---

## Task 3: Command palette — remove the density toggle

**Files:**
- Modify: `web/app/components/command-palette.tsx`

**Interfaces:**
- Consumes: nothing new.
- Removes: this file's only remaining reference to `lib/density.ts`/`lib/use-density.ts` (`toggleDensity`, `useDensity`) and the `Gauge` icon import. After this task, no file outside `lib/density.ts` itself references it.

- [ ] **Step 1: Remove the density-related imports**

Old:
```tsx
import {
  Activity,
  BarChart3,
  Gauge,
  Newspaper,
  Radio,
  Search,
  Settings as SettingsIcon,
  Sparkles,
} from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { toggleDensity } from "@/lib/density";
import { useDensity } from "@/lib/use-density";
```

New:
```tsx
import {
  Activity,
  BarChart3,
  Newspaper,
  Radio,
  Search,
  Settings as SettingsIcon,
  Sparkles,
} from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
```

- [ ] **Step 2: Update the component's doc comment**

Old:
```tsx
/**
 * Global ⌘K / Ctrl+K command palette, mounted once in `app/layout.tsx` so
 * it's reachable from every page. Three sections:
 *
 * - Navigate: the app's pages.
 * - Actions: a density toggle, wired to Employee D2's
 *   ("keyboard-shortcuts-and-density") `toggleDensity()`/`useDensity()`
 *   from `@/lib/density` (this item started as a disabled stub before
 *   D2's PR merged into this branch — see git history). There's no theme
 *   toggle here -- this app has no light/dark mode, only the four
 *   `data-background` neutrals (Settings' own Background control).
 * - Games: fuzzy search over real games, fetched from the existing
 *   `/api/games` BFF route (the same route Explorer's data flows through).
 *   Selecting one navigates to `/explorer?game_id=<id>` — a bare
 *   navigation fallback, since no game-detail affordance to scroll-to/
 *   highlight exists yet on this branch.
 *
 * Per the ui-ux-pro-max "Keyboard Navigation" guideline (Accessibility,
 * High severity — full keyboard operability with visible focus on every
 * operable control), the palette must be entirely keyboard-drivable: ⌘K/
 * Ctrl+K opens it, arrow keys move the highlighted item (native to
 * shadcn's `Command`/`cmdk`), Enter selects, and Escape closes (native to
 * the underlying `Dialog`). No mouse-only affordance exists anywhere here.
 */
```

New:
```tsx
/**
 * Global ⌘K / Ctrl+K command palette, mounted once in `app/layout.tsx` so
 * it's reachable from every page. Two sections:
 *
 * - Navigate: the app's pages.
 * - Games: fuzzy search over real games, fetched from the existing
 *   `/api/games` BFF route (the same route Explorer's data flows through).
 *   Selecting one navigates to `/explorer?game_id=<id>` — a bare
 *   navigation fallback, since no game-detail affordance to scroll-to/
 *   highlight exists yet on this branch.
 *
 * The density toggle this palette used to carry (an "Actions" section)
 * was removed in the v2 UI rework -- density is now a single fixed
 * value, not a runtime preference. There's no theme toggle here either --
 * this app has one fixed dark theme, not a picker (see
 * docs/superpowers/specs/2026-09-09-ui-rework-trading-terminal-design.md).
 *
 * Per the ui-ux-pro-max "Keyboard Navigation" guideline (Accessibility,
 * High severity — full keyboard operability with visible focus on every
 * operable control), the palette must be entirely keyboard-drivable: ⌘K/
 * Ctrl+K opens it, arrow keys move the highlighted item (native to
 * shadcn's `Command`/`cmdk`), Enter selects, and Escape closes (native to
 * the underlying `Dialog`). No mouse-only affordance exists anywhere here.
 */
```

- [ ] **Step 3: Remove the density state variable**

Old:
```tsx
  const router = useRouter();
  const [density] = useDensity();
  const [open, setOpen] = useState(false);
```

New:
```tsx
  const router = useRouter();
  const [open, setOpen] = useState(false);
```

- [ ] **Step 4: Remove the "Actions" command group**

Old:
```tsx
        <CommandSeparator />

        <CommandGroup heading="Actions">
          {/*
            Wired to Employee D2's ("keyboard-shortcuts-and-density")
            `toggleDensity()`/`useDensity()` from `@/lib/density`, merged
            into this branch after this component was first built (see
            git history — this item started as a disabled TODO stub before
            D2's PR merged). `useDensity()` gives a reactive read so the
            label reflects the live density even if it was changed
            elsewhere (a keyboard shortcut, another palette invocation).
          */}
          <CommandItem
            value="toggle density compact comfortable"
            onSelect={() => runAndClose(() => toggleDensity())}
          >
            <Gauge aria-hidden="true" />
            <span>
              {density === "compact"
                ? "Switch to comfortable density"
                : "Switch to compact density"}
            </span>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Games">
```

New:
```tsx
        <CommandSeparator />

        <CommandGroup heading="Games">
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint` from `web/`
Expected: no errors, no unused-import warnings.

- [ ] **Step 6: Commit**

```bash
git add web/app/components/command-palette.tsx
git commit -m "feat(web): remove density toggle from command palette"
```

---

## Task 4: Settings page — drop font/background/density controls, keep text size + Your data

**Files:**
- Modify: `web/app/components/sections/settings-section.tsx` (full-file replacement)

**Interfaces:**
- Consumes: `useTextSize()` from `@/lib/use-text-size` (unchanged), `FAVORITE_TEAMS_KEY`/`SAVED_SEARCHES_KEY` from `@/app/components/sections/explorer-section` (unchanged).
- Removes: this file's only remaining references to `lib/font-choice.ts`, `lib/use-font-choice.ts`, `lib/background-choice.ts`, `lib/use-background-choice.ts`, `lib/density.ts`, `lib/use-density.ts`. After this task, nothing outside those six files themselves references them — confirmed by grepping `font-choice|background-choice|use-density|FONT_CHOICE|BACKGROUND_CHOICE|useDensity|lib/density` across `web/` after Tasks 2–4 land.

- [ ] **Step 1: Replace `app/components/sections/settings-section.tsx` with the following complete content**

```tsx
"use client";

import { useState, useSyncExternalStore } from "react";
import { Star, Bookmark } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type TextSize } from "@/lib/text-size";
import { useTextSize } from "@/lib/use-text-size";
import * as localStore from "@/lib/local-store";
import { FAVORITE_TEAMS_KEY, SAVED_SEARCHES_KEY } from "@/app/components/sections/explorer-section";

const emptySubscribe = () => () => {};

/** True only once the client has hydrated -- every control on this page
 * reads a preference that lives in localStorage and would otherwise
 * render a value the server can't know, causing a hydration mismatch.
 * Same `useSyncExternalStore` pattern as `explorer-section.tsx`'s
 * `useHasMounted`. */
function useHasMounted() {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string; icon?: React.ComponentType<{ className?: string }> }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" className="flex flex-wrap gap-2">
      {options.map(({ value: optionValue, label, icon: Icon }) => {
        const active = optionValue === value;
        return (
          <Button
            key={optionValue}
            type="button"
            role="radio"
            aria-checked={active}
            variant={active ? "default" : "outline"}
            size="sm"
            className="cursor-pointer"
            onClick={() => onChange(optionValue)}
          >
            {Icon && <Icon className="size-3.5" />}
            {label}
          </Button>
        );
      })}
    </div>
  );
}

const TEXT_SIZE_OPTIONS: { value: TextSize; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "large", label: "Large" },
  { value: "larger", label: "Larger" },
];

export function SettingsSection() {
  const hasMounted = useHasMounted();
  const [textSize, setTextSize] = useTextSize();

  return (
    <div className="flex w-full max-w-3xl flex-1 flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-bold tracking-wide text-foreground uppercase">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Every preference here is saved to this browser only -- there&apos;s no account system, so
          nothing syncs across devices.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Accessibility</CardTitle>
          <CardDescription>Text size across the whole app.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-foreground">Text size</span>
            {hasMounted ? (
              <SegmentedControl options={TEXT_SIZE_OPTIONS} value={textSize} onChange={setTextSize} />
            ) : (
              <div className="h-7 w-56 animate-pulse rounded-lg bg-muted" aria-hidden="true" />
            )}
            <p className="text-xs text-muted-foreground">
              Scales every table, card, and label app-wide. Defaults to Large.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your data</CardTitle>
          <CardDescription>
            Favorite teams and saved searches from the Historical Explorer, stored in this
            browser&apos;s local storage.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <DataResetRow
            icon={Star}
            label="Favorite teams"
            storageKey={FAVORITE_TEAMS_KEY}
            itemNoun="team"
          />
          <DataResetRow
            icon={Bookmark}
            label="Saved searches"
            storageKey={SAVED_SEARCHES_KEY}
            itemNoun="search"
          />
        </CardContent>
      </Card>
    </div>
  );
}

export default SettingsSection;

function DataResetRow({
  icon: Icon,
  label,
  storageKey,
  itemNoun,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  storageKey: string;
  itemNoun: string;
}) {
  const hasMounted = useHasMounted();
  // Initialized lazily from localStorage on first client render; clicking
  // Clear updates this directly rather than re-reading storage, so the
  // count reflects the click immediately.
  const [count, setCount] = useState(() => localStore.get<unknown[]>(storageKey, []).length);
  const displayCount = hasMounted ? count : 0;

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3">
      <div className="flex items-center gap-2 text-sm">
        <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="text-foreground">{label}</span>
        <span className="text-muted-foreground">
          ({displayCount} {itemNoun}
          {displayCount === 1 ? "" : "s"})
        </span>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="cursor-pointer"
        disabled={!hasMounted || count === 0}
        onClick={() => {
          localStore.remove(storageKey);
          setCount(0);
        }}
      >
        Clear
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npm run lint` from `web/`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/app/components/sections/settings-section.tsx
git commit -m "feat(web): slim settings to text size + Your data, drop appearance picker"
```

---

## Task 5: Delete the now-unreferenced font/background/density modules

**Files:**
- Delete: `web/lib/font-choice.ts`, `web/lib/use-font-choice.ts`, `web/lib/background-choice.ts`, `web/lib/use-background-choice.ts`, `web/lib/density.ts`, `web/lib/use-density.ts`
- Modify: `web/lib/text-size.ts` (comment only — it references `lib/density.ts`'s header comment, which no longer exists)

**Interfaces:**
- Consumes: nothing (this task only removes files after Tasks 2–4 removed every reference to them).

- [ ] **Step 1: Confirm nothing still references these modules**

Run (from `web/`):
```bash
grep -rln "font-choice\|background-choice\|use-density\|FONT_CHOICE\|BACKGROUND_CHOICE\|useDensity\|lib/density" --include="*.tsx" --include="*.ts" .
```
Expected: only the six files being deleted in this task appear (`lib/font-choice.ts`, `lib/use-font-choice.ts`, `lib/background-choice.ts`, `lib/use-background-choice.ts`, `lib/density.ts`, `lib/use-density.ts`) plus `lib/text-size.ts` (its comment, fixed in Step 3 below). If any other file appears, stop — Tasks 2–4 weren't fully applied; go back and finish them before deleting anything here.

- [ ] **Step 2: Delete the six files**

```bash
git rm web/lib/font-choice.ts web/lib/use-font-choice.ts web/lib/background-choice.ts web/lib/use-background-choice.ts web/lib/density.ts web/lib/use-density.ts
```

- [ ] **Step 3: Fix `lib/text-size.ts`'s stale cross-reference comment**

Read the file's header comment (it says something like "mirroring `lib/density.ts`'s exact shape (storage key, DOM-attribute application, change event, hook)" and "Deliberately NOT marked 'use client' -- see lib/density.ts's header for why"). Since `lib/density.ts` no longer exists, replace both of those cross-references with the actual reasoning inline instead of pointing at a deleted file: this file is deliberately NOT marked `"use client"` because `app/layout.tsx`, a Server Component, imports its exported constants (`TEXT_SIZE_STORAGE_KEY`, `DEFAULT_TEXT_SIZE`) directly for the blocking init script — a `"use client"` file's exports resolve to opaque client-reference proxies when accessed from server code, and the reactive hook that needs `useState`/`useEffect` lives in the separate `lib/use-text-size.ts` file instead, which server code never imports.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npm run lint` from `web/`
Expected: no errors, no dangling imports.

- [ ] **Step 5: Commit**

```bash
git add -A web/lib
git commit -m "chore(web): delete unused font/background/density picker modules"
```

---

## Task 6: `success` badge variant, wired into schema-change visuals

**Files:**
- Modify: `web/components/ui/badge.tsx`
- Modify: `web/app/quality/quality-shared.tsx`

**Interfaces:**
- Produces: `badgeVariants`'s `variant` prop gains a `"success"` option (alongside existing `default`/`secondary`/`destructive`/`outline`/`ghost`/`link`) — consumed by `schemaChangeBadgeVisual`'s updated return type below, and available to any future caller of `<Badge variant="success">`.
- Modifies: `schemaChangeBadgeVisual(changeType: string)`'s return type from `{ variant: "secondary" | "destructive" | "outline"; icon: ReactNode }` to `{ variant: "success" | "destructive" | "outline"; icon: ReactNode }` — its `"added"` case moves from `"secondary"` (neutral gray) to `"success"` (green), distinguishing "a field was added" (informational-positive) from `"removed"` (`"destructive"`, red) at a glance, while keeping the icon pairing (`<Plus />`/`<Minus />`/`<ArrowRightLeft />`) that already makes this colorblind-safe. `quality-tables.tsx` already destructures `{ variant, icon }` from this function and passes `variant` straight to `<Badge variant={variant}>` — no change needed there, since `Badge`'s prop type is inferred from `badgeVariants`.

- [ ] **Step 1: Add the `success` variant to `badgeVariants`**

Old:
```tsx
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
```

New:
```tsx
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        success:
          "bg-success/10 text-success focus-visible:ring-success/20 dark:bg-success/20 dark:focus-visible:ring-success/40 [a]:hover:bg-success/20",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
```

This mirrors `destructive`'s exact shape (low-opacity background tint, full-opacity text) so `text-success`'s contrast against the actual page background is what Task 1's comment measured (~7.9–8.7:1), not against some intermediate tinted fill.

- [ ] **Step 2: Wire it into `schemaChangeBadgeVisual`**

Old:
```tsx
// Visual treatment per schema-change type: each pairs a distinct badge
// variant with a distinct icon so the change type is never conveyed by
// color alone. The badge's visible text is always the raw `change_type`
// string from the API — this only decides the icon/variant around it.
export function schemaChangeBadgeVisual(changeType: string): {
  variant: "secondary" | "destructive" | "outline";
  icon: ReactNode;
} {
  switch (changeType) {
    case "added":
      return { variant: "secondary", icon: <Plus /> };
    case "removed":
      return { variant: "destructive", icon: <Minus /> };
    case "type_changed":
      return { variant: "outline", icon: <ArrowRightLeft /> };
    default:
      return { variant: "outline", icon: <ArrowRightLeft /> };
  }
}
```

New:
```tsx
// Visual treatment per schema-change type: each pairs a distinct badge
// variant with a distinct icon so the change type is never conveyed by
// color alone. The badge's visible text is always the raw `change_type`
// string from the API — this only decides the icon/variant around it.
// "added" uses the `success` (green) variant -- a field appearing is
// informational-positive, distinct from "removed" (destructive/red).
export function schemaChangeBadgeVisual(changeType: string): {
  variant: "success" | "destructive" | "outline";
  icon: ReactNode;
} {
  switch (changeType) {
    case "added":
      return { variant: "success", icon: <Plus /> };
    case "removed":
      return { variant: "destructive", icon: <Minus /> };
    case "type_changed":
      return { variant: "outline", icon: <ArrowRightLeft /> };
    default:
      return { variant: "outline", icon: <ArrowRightLeft /> };
  }
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run lint` from `web/`
Expected: no errors — `Badge`'s `variant` prop type is inferred from `badgeVariants` via `VariantProps`, so `quality-tables.tsx`'s existing `<Badge variant={variant}>` call (which destructures straight from `schemaChangeBadgeVisual`'s return value) type-checks against the new union without any edit there.

- [ ] **Step 4: Commit**

```bash
git add web/components/ui/badge.tsx web/app/quality/quality-shared.tsx
git commit -m "feat(web): add success badge variant, use it for added schema fields"
```

---

## Task 7: Extract a shared `LivePulse` indicator from `LiveBoard`

**Files:**
- Create: `web/app/components/live-pulse.tsx`
- Modify: `web/app/live/LiveBoard.tsx:148-167` (the `GameStatusBadge` function)

**Interfaces:**
- Produces: `LivePulse({ label?: string }): JSX.Element` — a pulsing dot + text label, defaulting to `"LIVE"`. Exported as both a named export and default export, matching this codebase's convention (see `RecentGamesBoard`, `SiteHeader`).
- Consumes (in `LiveBoard.tsx`): the new `LivePulse` component, replacing the inline dot+label markup previously inside `GameStatusBadge`'s `"live"` branch. The surrounding `<Badge variant="secondary" className="gap-1.5 border-transparent bg-primary text-primary-foreground">` wrapper is unchanged — `LivePulse` is just its children, not a replacement for `Badge` itself.

- [ ] **Step 1: Create `app/components/live-pulse.tsx`**

```tsx
/**
 * Pulsing-dot "LIVE" indicator, extracted from `app/live/LiveBoard.tsx`'s
 * `GameStatusBadge` so any future live-state surface (per the v2 UI
 * rework's spec, "shared between the home board, /live, and anywhere
 * else a live state is shown") can reuse the exact same treatment
 * instead of re-implementing the ping animation.
 *
 * The dot is `aria-hidden` decoration; `label` (always visible text, not
 * a screen-reader-only affordance) is what actually conveys "live" --
 * this must never be the only thing that changes color, and the text
 * label already makes that a non-issue here. Callers are responsible for
 * their own `aria-live`/announcement behavior around this, same as
 * before (see `GameStatusBadge`'s own comment on why it doesn't
 * re-announce on every SSE tick).
 *
 * Not a `Badge` itself -- callers wrap this in whatever container variant
 * makes sense for their context (see `LiveBoard.tsx`'s
 * `GameStatusBadge`, which wraps it in a `Badge`).
 */
export function LivePulse({ label = "LIVE" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="relative flex size-1.5">
        <span className="absolute inline-flex size-full rounded-full bg-primary-foreground/70 motion-safe:animate-ping" />
        <span className="relative inline-flex size-1.5 rounded-full bg-primary-foreground" />
      </span>
      {label}
    </span>
  );
}

export default LivePulse;
```

- [ ] **Step 2: Add the import to `LiveBoard.tsx`**

Old:
```tsx
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { isLiveStatus } from "@/lib/live-status";
```

New:
```tsx
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LivePulse } from "@/app/components/live-pulse";
import { isLiveStatus } from "@/lib/live-status";
```

- [ ] **Step 3: Replace `GameStatusBadge`'s inline dot+label with `LivePulse`**

Old:
```tsx
function GameStatusBadge({ status }: { status?: string }) {
  const presentation = getStatusPresentation(status);

  if (presentation.kind === "live") {
    return (
      <Badge
        variant="secondary"
        className="gap-1.5 border-transparent bg-primary text-primary-foreground"
      >
        <span aria-hidden="true" className="relative flex size-1.5">
          <span className="absolute inline-flex size-full rounded-full bg-primary-foreground/70 motion-safe:animate-ping" />
          <span className="relative inline-flex size-1.5 rounded-full bg-primary-foreground" />
        </span>
        {presentation.label}
      </Badge>
    );
  }

  return <Badge variant={presentation.variant}>{presentation.label}</Badge>;
}
```

New:
```tsx
function GameStatusBadge({ status }: { status?: string }) {
  const presentation = getStatusPresentation(status);

  if (presentation.kind === "live") {
    return (
      <Badge
        variant="secondary"
        className="gap-1.5 border-transparent bg-primary text-primary-foreground"
      >
        <LivePulse label={presentation.label} />
      </Badge>
    );
  }

  return <Badge variant={presentation.variant}>{presentation.label}</Badge>;
}
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npm run lint` from `web/`
Expected: no errors. The rendered DOM for the live badge is identical to before (same markup, just sourced from a shared component) — confirm this visually in Task 9's browser walkthrough rather than re-verifying here.

- [ ] **Step 5: Commit**

```bash
git add web/app/components/live-pulse.tsx web/app/live/LiveBoard.tsx
git commit -m "refactor(web): extract shared LivePulse indicator from LiveBoard"
```

---

## Task 8: Extract a shared `StatTile` component from `quality-section`'s inline KPI cards

**Files:**
- Create: `web/app/components/stat-tile.tsx`
- Modify: `web/app/components/sections/quality-section.tsx:166-195` (the per-metric KPI grid) and `:266-281` (the "Total conflicts" card)

**Interfaces:**
- Produces: `StatTile({ label: string; value: string; caption?: string }): JSX.Element` — a small KPI card (label, large mono tabular-numeric value, optional caption), built on the existing `Card`/`CardHeader`/`CardContent` primitives (not a new primitive-level component, per the spec's "reskin, don't rebuild" constraint).
- Consumes (in `quality-section.tsx`): replaces two existing inline `<Card size="sm">...</Card>` blocks with `<StatTile .../>` calls, passing the exact same values (`metric.check_name`/`formatValue(metric.value)`/`metric.run_at`, and `"Total conflicts"`/`result.data.quality.conflicts.total.toLocaleString()`) each already computed today — no data or formatting changes, purely a markup extraction.

- [ ] **Step 1: Create `app/components/stat-tile.tsx`**

```tsx
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/**
 * Small KPI tile -- label, a large monospace tabular-numeric value, and
 * an optional caption -- extracted from two identical inline `Card`
 * blocks in `app/components/sections/quality-section.tsx` (the per-metric
 * grid and the "Total conflicts" card). Per the v2 UI rework's design
 * spec, this is the shared building block for any future headline number
 * (quality metrics, KPIs) rather than each call site re-typing the same
 * `Card`/`CardHeader`/`CardContent` markup.
 */
export function StatTile({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption?: string;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <p className="font-mono text-2xl font-semibold tabular-nums text-foreground">
          {value}
        </p>
        {caption ? <p className="text-xs text-muted-foreground">{caption}</p> : null}
      </CardContent>
    </Card>
  );
}

export default StatTile;
```

- [ ] **Step 2: Add the import to `quality-section.tsx`**

Old:
```tsx
import {
  AgreementGaugeChart,
  NullRateTrendChart,
  PsiPerFieldChart,
  type HistoryPoint,
  type PsiFieldSeries,
} from "@/app/quality/quality-charts";
import {
  EmptySectionState,
  formatValue,
  type QualityResponse,
} from "@/app/quality/quality-shared";
import { SortableConflictsTable, SortableSchemaChangesTable } from "@/app/quality/quality-tables";
```

New:
```tsx
import {
  AgreementGaugeChart,
  NullRateTrendChart,
  PsiPerFieldChart,
  type HistoryPoint,
  type PsiFieldSeries,
} from "@/app/quality/quality-charts";
import {
  EmptySectionState,
  formatValue,
  type QualityResponse,
} from "@/app/quality/quality-shared";
import { SortableConflictsTable, SortableSchemaChangesTable } from "@/app/quality/quality-tables";
import { StatTile } from "@/app/components/stat-tile";
```

- [ ] **Step 3: Replace the per-metric KPI grid**

Old:
```tsx
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {result.data.quality.metrics.map((metric) => (
                  <Card key={metric.check_name} size="sm">
                    <CardHeader>
                      <p className="truncate text-xs font-medium text-muted-foreground">
                        {metric.check_name}
                      </p>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-1">
                      <p className="font-mono text-2xl font-semibold tabular-nums text-foreground">
                        {formatValue(metric.value)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {metric.run_at}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
```

New:
```tsx
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {result.data.quality.metrics.map((metric) => (
                  <StatTile
                    key={metric.check_name}
                    label={metric.check_name}
                    value={formatValue(metric.value)}
                    caption={metric.run_at}
                  />
                ))}
              </div>
```

- [ ] **Step 4: Replace the "Total conflicts" card**

Old:
```tsx
            <Card size="sm" className="w-fit min-w-40">
              <CardHeader>
                <p className="text-xs font-medium text-muted-foreground">
                  Total conflicts
                </p>
              </CardHeader>
              <CardContent>
                <p className="font-mono text-2xl font-semibold tabular-nums text-foreground">
                  {result.data.quality.conflicts.total.toLocaleString()}
                </p>
              </CardContent>
            </Card>
```

New:
```tsx
            <div className="w-fit min-w-40">
              <StatTile
                label="Total conflicts"
                value={result.data.quality.conflicts.total.toLocaleString()}
              />
            </div>
```

(The `w-fit min-w-40` sizing moves from the `Card` itself to a wrapping `div`, since `StatTile` doesn't expose a `className` prop — it's a fixed-shape tile by design, matching the "one deliberate design, not a configurable primitive" spirit of this rework. If a future caller needs a different width, that's a reason to add a `className` prop then, not now.)

- [ ] **Step 5: Verify `Card`/`CardHeader`/`CardContent` imports are still needed**

`quality-section.tsx` still uses bare `Card`/`CardHeader`/`CardContent` for the three chart-wrapper cards further down (`Null rate trend`, `PSI per field`, `Cross-source agreement`) — confirm those are untouched and the import line at the top of the file (`import { Card, CardContent, CardHeader } from "@/components/ui/card";`) stays exactly as-is (still needed, not now unused).

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npm run lint` from `web/`
Expected: no errors, no unused-import warnings.

- [ ] **Step 7: Commit**

```bash
git add web/app/components/stat-tile.tsx web/app/components/sections/quality-section.tsx
git commit -m "refactor(web): extract shared StatTile from quality-section's KPI cards"
```

---

## Task 9: Full verification pass

**Files:** none (verification only)

**Interfaces:** none — this task confirms Tasks 1–8 together produce a working, correctly-themed app.

- [ ] **Step 1: Full typecheck and lint**

Run: `npx tsc --noEmit && npm run lint` from `web/`
Expected: clean, matching the `web-check` CI job.

- [ ] **Step 2: Run the existing test suite**

Run: `npx vitest run` from `web/`
Expected: all existing tests pass unchanged — this plan touched no `lib/` logic and no tested component (`search-section`, `search-result-tables`, the `/api/search` route), so nothing here should need test updates.

- [ ] **Step 3: Confirm no remaining references to the removed picker**

Run (from `web/`):
```bash
grep -rn "font-choice\|background-choice\|use-density\|FONT_CHOICE\|BACKGROUND_CHOICE\|useDensity\|lib/density\|data-font\|data-background\|data-density\|font-active-raw" --include="*.tsx" --include="*.ts" --include="*.css" .
```
Expected: no matches anywhere in `web/`.

- [ ] **Step 4: Browser walkthrough**

Run `npm run dev` from `web/` and, in a browser, check every route the design spec names plus the dynamic detail pages the token layer also touches:

`/`, `/live`, `/live/[gameId]` (open any live game link, or navigate directly with a known game id), `/explorer`, `/quality`, `/news`, `/search`, `/settings`, `/games/[id]` (open any game from `/explorer`), `/players/[id]` (open any player from `/explorer`), `/teams/[abbreviation]` (open any team link).

For each, confirm:
- On `/` specifically: the game board is the first thing rendered below the header/ticker, with no marketing copy above it (the pipeline-description paragraphs stay in the footer, below the board).
- Single dark theme renders (near-black background, amber accent) — no flash of a different palette on load.
- All UI chrome and body text render in Geist Sans; all scores/stats/timestamps render in Geist Mono with fixed-width digits (compare two different numbers in the same column — they should align).
- Sharper corners than before (radius is visibly tighter, not the old rounder shadcn default).
- `/settings` shows only "Accessibility" (text size) and "Your data" (favorite teams / saved searches reset, both still functional) — no font/background/density controls.
- ⌘K/Ctrl+K command palette opens; "Actions" section is gone; Navigate and Games sections still work.
- `/live`'s live-game cards (if any games are live at test time, otherwise confirm via `LiveBoardSkeleton`/`LiveBoardEmpty`) show the pulsing "LIVE" badge correctly. Specifically confirm spacing/alignment is unchanged from before the Task 7 extraction — `LivePulse`'s own wrapping `<span>` adds one extra DOM node around the dot+label versus the pre-extraction inline markup (both use the same `inline-flex items-center gap-1.5` treatment, so this is expected to be visually inert, but verify rather than assume; task-7 review flagged this for confirmation here).
- `/quality`'s per-metric grid and "Total conflicts" card render as `StatTile`s with the same values as before; a schema change of type `"added"` (if any exist in the data) shows the green `success` badge, `"removed"` shows red `destructive`.
- No console errors.

Note one known, pre-existing, out-of-scope issue you will see and should NOT fix here: `recent-games-board.tsx` and `app/teams/[abbreviation]/page.tsx` use a bare `font-bebas-neue-raw` class (not the `font-[family-name:var(--font-bebas-neue-raw)]` arbitrary-value syntax `site-header.tsx` correctly uses), which isn't a real Tailwind utility and silently falls back to the inherited font. This predates this rework, isn't part of its spec, and fixing it is unrelated cleanup — leave it alone unless the user asks for it separately.

- [ ] **Step 5: Confirm contrast values against the actually-rendered page**

Using the browser's DevTools color picker (or an extension) on the running `/quality` page, sample: body text against `--background`, `--muted-foreground` labels against `--card`, the amber `--primary` accent against `--background`, `--success` (green) text against `--card`, and `--destructive` (red) text against `--card`. Confirm they match the values computed in Task 1's comment (destructive ~4.16:1, success ~7.9:1 against card) — if a sampled value disagrees with the comment, stop and reconcile before calling this done, since the comment is asserting a specific number.

This task has no commit of its own — it's a gate. If anything fails, fix it in the task it belongs to (don't patch it here) and re-run this task's steps.
