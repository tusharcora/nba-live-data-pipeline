# v2 UI rework: Greptile/Kalshi/Polymarket-inspired trading-terminal design

## Overview

A complete visual rework of the `web/` app, replacing the current
shadcn/ui + sports-broadcast aesthetic (condensed display fonts, a
4-palette dark-neutral picker, a per-user font/background/density
customization system) with one deliberate, opinionated dark design —
anchored on a blend of **Greptile** (clean, technical, restrained
dev-tool aesthetic) and **Kalshi/Polymarket** (dense, data-forward
trading-terminal cards, monospace numerics). The goal is a portfolio
front door that reads as a serious, well-crafted product to a visitor
in the first five seconds, not a functional-but-plain dashboard.

Scope is the whole app — `/`, `/live`, `/explorer`, `/quality`,
`/news`, `/search`, `/settings` — executed as one token/primitive pass
followed by a page-by-page sweep, not independent per-page redesigns
and not a parallel `/v2` route tree. `/` becomes the hero: it leads
directly with the live product (the game board), not marketing copy
above it, per the "lead with the live product" direction.

## PRD amendment (already applied)

The PRD's UI bar (`docs/prd.md` §11, mirroring the canonical
[PRD artifact](https://claude.ai/code/artifact/1f4076ad-1c3c-403a-b3a5-d987db3f10d0))
required "both themes, real contrast in each" and repeated that in the
Week 5 plan. This rework replaces that with a single fixed dark theme
and drops the runtime font/background/density picker. Both the
canonical artifact and the local `docs/prd.md` mirror have already been
updated with an explicit amendment note (struck-through original
requirement + reasoning), so the two documents don't disagree. The
WCAG AA contrast and colorblind-safe color+icon/label pairing
requirement in the same section is **unchanged** and still governs
every semantic color introduced here.

## Goals

- One fixed, deliberate dark visual language across every page —
  Greptile-restrained chrome, Kalshi/Polymarket-dense data surfaces.
- `/` leads with the live product immediately (hero = the game board).
- Reskin existing shadcn/Radix primitives against new tokens; add a
  small number of new data-dense components on top.
- Carry forward every existing accessibility commitment (WCAG AA
  contrast, colorblind-safe semantic pairing, keyboard nav, focus
  states) into the new palette — a visual pass must not regress these.

## Non-goals

- No framer-motion or other animation dependency — pulse/tick motion
  is CSS-only, a deliberate low-ceremony choice consistent with this
  project's general "didn't add X" documentation pattern, not an
  oversight.
- No backend/API changes. This is a `web/`-only rework.
- No rebuild of shadcn/Radix primitives from scratch.
- No changes to the live win-probability model, ingestion, or data
  quality logic.
- `/settings`'s "Your data" reset controls (favorite teams, saved
  searches) are functional, not cosmetic, and are kept as-is.

## Visual language (token layer)

- **Theme**: single fixed dark theme, replacing `lib/background-choice.ts`'s
  4-palette picker. Near-true-black background (darker than the
  current "Charcoal" default) — closer to Kalshi/Polymarket's
  near-black surfaces than the current warm-neutral options.
- **Typography**: two fixed faces, replacing `lib/font-choice.ts`'s
  7-font picker (which currently mislabels a user-chosen *display*
  font, default Barlow Condensed, as `--font-mono` — not an actual
  monospace face). New setup:
  - **Geist Sans** for all UI chrome, body copy, and headings —
    already loaded in `app/layout.tsx`, restrained and technical,
    matches the Greptile anchor.
  - **Geist Mono** (newly added `next/font/google` import) for every
    numeric — scores, stats, timestamps, percentages, KPI values. A
    genuine monospace face, so tabular/fixed-width digits are
    guaranteed by construction — this is what makes ticking-number
    score transitions not jitter, unlike the current mono variable.
  - The brand wordmark keeps its existing fixed Bebas Neue treatment,
    unaffected by this change (it already ignores the font picker).
- **Color**: keep the amber `#F5A623` as brand/accent — it's already
  doing semantic work in the ticker's "FINAL" tag — and add a proper
  green/red semantic pair for win/loss, over/under, and data-quality
  pass/fail states, which are currently under-defined. Every use of
  the new green/red pair ships with a non-color signal too (icon or
  text label), never color alone, per the PRD's unchanged accessibility
  bar. A dedicated contrast-check pass (4.5:1 body text, 3:1 UI
  components/large text, WCAG AA) runs against the full token set —
  background, amber, and both semantic colors — once at this token
  layer, before the page-by-page sweep, rather than being discovered
  page-by-page later.
- **Density**: single fixed compact-leaning spacing scale, replacing
  `lib/density.ts`'s comfortable/compact toggle — tighter row heights
  and card padding by default, closer to a trading terminal's density
  than the current "comfortable" default.
- **Radius**: smaller, sharper corners than shadcn's current defaults
  (`--radius` and its derived scale in `app/globals.css`) — sharper
  corners read more "terminal," less "consumer app."
- **Motion**: a live-pulse dot for in-progress games and a brief
  transition on score changes, both plain CSS (`@keyframes` /
  `transition`), matching the existing `ticker-scroll` keyframe
  already in `app/globals.css`. Respects `motion-reduce`, matching the
  ticker's existing pattern.

## What gets removed

- `lib/font-choice.ts`, `lib/background-choice.ts`, `lib/density.ts`
  and their `use-*-choice`/`use-density` hooks, and every reference to
  them (`app/layout.tsx`'s blocking init script, `SettingsSection`'s
  Appearance card, `app/globals.css`'s `data-font`/`data-background`/
  `data-density` attribute selectors).
- `lib/text-size.ts` and its hook are **kept** — it's a plausible
  accessibility control distinct from the look-and-feel pickers being
  dropped.

## `/settings` after the rework

`SettingsSection` loses its Appearance card's font/background/density
controls but keeps:
- **Text size** control (kept as the one surviving appearance-ish
  setting, framed as accessibility rather than "look").
- **Your data** card (favorite teams / saved searches reset) —
  unchanged, since it's real functionality unrelated to the palette
  system.

`/settings` stays a nav destination (not retired) because of the
"Your data" controls.

## Navigation & chrome

The existing top bar + full-bleed scrolling ticker (`SiteHeader`) and
the cmd-k command palette already match the target aesthetic
structurally — a slim technical topbar and a live data ticker is
already very Kalshi/Polymarket, and a keyboard-driven command palette
is already very Greptile. These are **reskinned against the new
tokens**, not replaced: tighter spacing, the new monospace face for
the ticker's numerics (it already uses `font-mono`), sharper corners,
the refreshed color set.

## Page-by-page treatment

- **`/` (home)**: the live game board becomes the hero with no
  marketing copy above it, per the "lead with the live product"
  direction. Game rows get a market-card treatment — live score,
  a momentum/delta indicator, monospace numerics — closer to a
  Polymarket market card than the current plain box-score row.
- **`/live`**: same market-card language as the home board, plus the
  existing live-indicator requirements (pulsing dot, last-updated
  timestamp) restyled to the new tokens.
- **`/explorer`, `/quality`, `/news`, `/search`**: Greptile-restrained
  — dense, well-typeset tables and charts (existing recharts usage in
  `quality-charts.tsx` restyled to the new token set, not replaced),
  generous whitespace between sections, minimal chrome.
- **`/settings`**: per the section above.

## New components

Small, additive — not a rebuild:
- **Stat/price-tile**: a KPI tile for quality metrics and other
  headline numbers, in the new monospace numeric style.
- **Market-card**: a variant of the existing game-row component with
  live score, delta indicator, and monospace numerics.
- **Live-pulse indicator**: the pulsing "LIVE" dot treatment, shared
  between the home board, `/live`, and anywhere else a live state is
  shown.

All three are built on top of existing shadcn primitives (`Card`,
`Badge`, etc.), not new primitive-level components.

## Testing / verification

- `npx tsc --noEmit` and `npm run lint` after the sweep, matching
  existing CI gates (`web-check`).
- No changes to existing test suites' expectations beyond what the
  removed font/background/density modules' own tests require deleting
  alongside them.
- Per top-level `CLAUDE.md` guidance, verify visually in a running
  `npm run dev` browser session on every page listed above — the
  golden path (live board, ticker, cmd-k palette, quality charts) and
  edge cases (loading skeleton, empty state, error state, mobile
  width) — rather than relying on `tsc`/lint alone to confirm the
  redesign reads correctly.
- Confirm the WCAG AA contrast pass (token layer) with real computed
  contrast ratios for background/foreground, amber accent, and the new
  green/red pair before sweeping pages.

## Rollout

Implemented directly on top of the current `main` (which already
includes the merged v2-sportsbook-redesign work) on a new branch,
opened as a PR when done — no parallel `/v2` route tree.
