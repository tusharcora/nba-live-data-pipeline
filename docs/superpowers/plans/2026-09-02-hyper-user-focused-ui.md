# "Hyper User Focused" UI Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development — one fresh specialized subagent ("employee") per task below, reviewed and merged by a "boss" subagent per team before human sign-off, exactly as executed for Weeks 1-6. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the user's explicit "hyper user focused" UI request — richer data visualization, personalization & saved state, deeper interactivity, and power-user efficiency, applied across the whole app (Home, Live Board, Quality Scorecard, Historical Explorer) — going beyond the PRD's own "fully furnished" checklist that Week 5 already satisfied.

**Architecture:** Four boss teams, run in parallel. Team A (data visualization) is backend+frontend and self-contained. Teams B, C, D are frontend-only and touch different pages/concerns with one deliberate shared-contract decision (below) that removes the one real cross-team collision risk found during planning review.

**Tech Stack:** `recharts` (new — charting), shadcn `command`/`dialog`/`dropdown-menu`/`popover` (new, wraps `cmdk`) via `npx shadcn@latest add command dialog dropdown-menu popover`. No new backend dependencies.

**Spec:** `docs/prd.md` §11 ("fully furnished" bar — this pass goes beyond it, not against it), `docs/PROGRESS.md`'s Known Issues (the two real data constraints below are already documented there).

## Global Constraints

- **No auth/user-accounts system exists and none is being added.** Personalization & saved state is `localStorage`-only, per-browser. Build a single typed wrapper, `web/lib/local-store.ts` (get/set/remove with try/catch guards around every operation — `localStorage` can throw in private browsing/storage-disabled contexts; mirror the fail-open philosophy already used in `api/src/api/core/cache.py`, i.e. a failed read/write degrades gracefully to "no saved state" rather than crashing the page). Every employee touching personalization (B1, B2, D2) imports this one wrapper — do not each write your own `localStorage` helper.
- **`quality_metrics` has zero real rows today** and the `/quality` endpoint only ever returns the latest row per check name (see `api/src/api/routers/quality.py`'s `_latest_per_check`) — never history. Team A's new endpoint is required infrastructure, not optional polish.
- **Shared data contract to avoid a repeat of Week 3's cross-team field-mismatch bug:** D1's command-palette game search and C1's Explorer team filter both work with the *same* `/games` response shape (`{game_id, game_date, home_team, away_team, home_score, away_score, ...}`, unchanged by this plan — see `api/src/api/routers/games.py`). **D1 fetches this directly from the existing, already-stable `/api/games` BFF route** (the same one Explorer already calls) — it does NOT depend on, import from, or wait for anything C1 builds. This is a deliberate design decision, not an oversight: it removes the coordination risk entirely rather than requiring D's boss to diff against C's branch.
- **Client-side filtering/sorting, not new backend params**, wherever the full dataset is already returned to the browser (games list, schema-change/conflicts tables) — this project's real data volumes are small (dozens of rows). The one genuinely new backend surface is quality-metrics *history* (Team A), since that data is never fully returned today.
- Every new interactive element needs a visible focus ring (reuse `FOCUS_RING`, exported from `web/app/components/site-nav.tsx`) and must be keyboard-operable.
- **Keyboard shortcuts (D2) must not fire while focus is inside a text input/textarea/contenteditable** — guard explicitly (e.g. check `document.activeElement.tagName` before handling a keydown), since Explorer's player-name search and the saved-search-label input are real text fields shortcuts could otherwise hijack.
- **Every UI-facing employee (A2, B1, B2, C1, C2, D1, D2 — i.e. everyone except A1's backend-only endpoint) MUST invoke the `ui-ux-pro-max` skill's search tool for their specific concern before implementing**, exactly as required in the Week 5 UI round — not optional, not "if useful." Run it via `python3 "/Users/tushar/.claude/plugins/cache/ui-ux-pro-max-skill/ui-ux-pro-max/2.13.0/.claude/skills/ui-ux-pro-max/scripts/search.py" "<query>" --domain <domain>`. Each task section below names the specific queries to run; cite what each query returned and how it was applied in the PR body, matching Week 5's precedent — do not implement UI from unaided taste.
- **Sandbox-vs-real-browser honesty (per Week 6's now-established standard):** no employee has live Postgres/Redis or a real browser in their sandbox. Every task below states explicitly what can and cannot be verified there — carry that distinction into each PR body rather than letting one global caveat get lost across four parallel bosses.

---

## Team A: `ui-pass/data-visualization` (2 employees)

### Employee A1: `quality-history-endpoint`

**Files:** Modify `api/src/api/routers/quality.py`. Test: extend `api/tests/test_quality.py`.

**Task:**
1. Add `GET /quality/history?check_name=<name>` returning every real `QualityMetric` row for that check name, ordered by `run_at` ascending: `{"check_name": str, "points": [{"run_at": "<iso8601>", "value": <number>}]}`. Follow this file's existing structure exactly: a new reader method (extend the existing reader protocol/`SQLAlchemyQualityReader` rather than inventing a parallel one — read the current reader class first), `require_api_key` dependency (already applied at the router level via `dependencies=[Depends(require_api_key)]` — confirm this by reading the router's current setup, don't re-add it redundantly), the shared `limiter`/`DEFAULT_RATE_LIMIT`, and `cached_json` wrapping with a short TTL matching this file's existing choices.
2. An unknown/never-seen `check_name` returns `{"check_name": ..., "points": []}` with `200`, not a `404` — matches this project's established "unfiltered/empty means empty" convention (see `/games`'s behavior with no matches).
3. Tests: multiple real rows returned in correct ascending order, an unknown check name returns an empty list, and extend the existing auth-bypass/rate-limit table-driven tests (`test_security_audit.py`/`test_rate_limit.py` patterns) to cover this new route the same way every prior route was covered.

**Skills for this task:** superpowers:test-driven-development. This is a backend-only task — no `ui-ux-pro-max` requirement (see Global Constraints).

### Employee A2: `scorecard-charts`

**Files:** Create: `web/app/api/quality-history/route.ts` (new BFF passthrough, mirroring `web/app/api/quality/route.ts`'s existing fetch-through pattern exactly). Modify `web/app/quality/page.tsx`. Modify `web/package.json` (add `recharts`).

**Task:**
1. **Before writing any component code**, run `ui-ux-pro-max` queries: `"time series chart small data"` and `"dashboard KPI chart accessible"` (both `--domain chart`), plus `"chart color accessible" --domain color`. Cite the results in your PR.
2. Add `recharts`. Build three visualizations on `web/app/quality/page.tsx`, fed by Employee A1's `GET /quality/history` via the new BFF route: a null-rate trend line, a small PSI-per-field chart, and an agreement-rate gauge/donut.
3. **This is the one task in this plan that cannot be meaningfully verified against real data by anyone, including the human, until the quality checks have actually run on a schedule** (`quality_metrics` has zero real rows as of this plan). Every chart must render sensibly with **0 points** (reuse the existing `EmptySectionState` component/pattern from this same file) and with **1 point** (a single-point "line" is a dot, not a broken chart — do not assume ≥2 points). Do not build a chart that looks broken or empty-but-different-from-intentional-empty-state at low data volumes — that is the actual, expected condition this ships into. State this explicitly and prominently in your PR: the human's post-merge Chrome walkthrough will show 0-1 real points regardless of when in the merge order this lands, and that is not a partial/incomplete result, it's the correct behavior for the data that currently exists.
4. `npx tsc --noEmit` and `npm run lint` must be clean.

**Skills for this task:** the `ui-ux-pro-max` skill (see step 1 — mandatory, not optional). superpowers:verification-before-completion for the honest 0/1-point framing in step 3.

---

## Team B: `ui-pass/personalization` (2 employees)

### Employee B1: `favorites-and-saved-searches`

**Files:** Create: `web/lib/local-store.ts` (the shared wrapper — see Global Constraints; B2 and D2 both import this, so get its shape right: typed `get<T>(key, fallback)`/`set<T>(key, value)`/`remove(key)`, every operation wrapped in try/catch, JSON-serialized). Modify `web/app/explorer/page.tsx`.

**Task:**
1. Run `ui-ux-pro-max` queries before implementing: `"filter chip favorite selection"` and `"saved search preset UI"` (`--domain ux`), plus a stack query `"local storage state hydration"` (`--stack nextjs`, since reading `localStorage` during SSR needs care — Next.js renders server-side first, so any `localStorage`-backed UI must handle a hydration mismatch, similar to how `theme-toggle.tsx` already solved this with `useSyncExternalStore` in Week 5 — read that file before implementing to reuse the same pattern rather than reinventing mount-detection).
2. Build `web/lib/local-store.ts` per the Global Constraints shape.
3. On Historical Explorer: a favorite-teams quick-filter chip row (favoriting is per-team, persisted via `local-store.ts`, clicking a favorited chip filters the games list to that team client-side — same client-side-filter principle as Employee C1, though this task and C1 can be built independently since favoriting/filtering-by-favorite is a distinct UI surface from C1's general team-filter dropdown; note this in your PR if you notice overlap so the boss can reconcile the two filter UIs into one coherent control during review rather than shipping two competing filter widgets).
4. Saved search presets: save the current `{startDate, endDate, playerName}` plus a user-typed label; list saved presets with load/delete actions.
5. `npx tsc --noEmit` and `npm run lint` clean. State plainly in the PR that actual `localStorage` persistence across a real reload needs the human's real browser (a sandboxed TestClient-less environment can't prove persistence survives a real page reload, only that the code calls the right APIs).

**Skills for this task:** the `ui-ux-pro-max` skill (mandatory).

### Employee B2: `home-customization`

**Files:** Modify `web/app/page.tsx`, `web/app/layout.tsx` (only if a last-visited-page listener needs to live above the page level — check whether a client component wrapping just the nav is sufficient before touching layout). Depends on Employee B1's `web/lib/local-store.ts` — wait for B1's PR to merge into the boss branch before starting (or coordinate with the boss on order if both are dispatched simultaneously; either way, do not duplicate `local-store.ts`).

**Task:**
1. Run `ui-ux-pro-max` queries before implementing: `"reorderable list drag handle"` and `"continue where you left off"` (`--domain ux`).
2. Let the user reorder and show/hide the three destination cards on the home page (`DESTINATIONS` array in `web/app/page.tsx`), persisted via `local-store.ts`. Keep this modest — up/down reorder controls or simple drag-and-drop of the three existing cards, not a new grid-builder framework.
3. **"Last visited page" is defined precisely as: the most recent of `/live`, `/quality`, or `/explorer` the user navigated to** (not every route/query-param change, not sub-states within a page). Record it on navigation to exactly those three routes; show a "Continue: <Page Name>" affordance on the home page when a value is recorded.
4. `npx tsc --noEmit` and `npm run lint` clean. Same real-`localStorage`-persistence caveat as B1 applies here.

**Skills for this task:** the `ui-ux-pro-max` skill (mandatory).

---

## Team C: `ui-pass/interactivity` (2 employees)

### Employee C1: `sortable-filterable-tables`

**Files:** Modify `web/app/quality/page.tsx`, `web/app/explorer/page.tsx`.

**Task:**
1. Run `ui-ux-pro-max` queries before implementing: `"sortable table column header"` and `"table filter dropdown"` (`--domain ux`).
2. Client-side sortable columns (click a header to sort, indicate direction) on the Quality Scorecard's schema-change and conflicts tables — data is already fully fetched to the browser server-side in this file, so this is pure client-side array sorting, no new API call.
3. Client-side team filter (dropdown or multi-select) on Historical Explorer's games list, filtering the already-fetched results.
4. If you notice this overlaps with Employee B1's favorite-team quick-filter chips (same underlying "filter games by team" concept, different entry point), note it plainly in your PR — do not silently duplicate the filtering state/logic; flag it for the boss to reconcile into one filter mechanism with two entry points (a favorites row and a full dropdown) rather than two independent, possibly-conflicting filter states.
5. `npx tsc --noEmit` and `npm run lint` clean — sorting/filtering behavior itself is fully verifiable in this sandbox (it's pure client-side logic over data already present in tests/fixtures), unlike the personalization tasks' persistence claims.

**Skills for this task:** the `ui-ux-pro-max` skill (mandatory).

### Employee C2: `drill-down-and-comparison`

**Files:** Modify `web/app/quality/page.tsx`, `web/app/explorer/page.tsx`.

**Task:**
1. Run `ui-ux-pro-max` queries before implementing: `"expandable row detail"` and `"side by side comparison view"` (`--domain ux`).
2. Extend the existing inline-expansion pattern already used for Explorer's box-score view (read that implementation first — reuse its expand/collapse mechanism, don't invent a second one) to the Quality Scorecard's schema-change rows: clicking a row reveals the full old-type/new-type diff detail.
3. Add a simple side-by-side **game** comparison on Historical Explorer: let the user select two real games from the already-fetched list and see their final scores and quarter-by-quarter breakdown next to each other (`games` Gold table has the `home_q1`..`home_q4`/away equivalents per the dbt model — confirm exact column names in `dbt/models/marts/games.sql` before using them, don't guess).
4. **Do not build player-level comparison** — `player_game_stats` has no real rows on the current API plan (documented, accepted limitation). Game-level comparison uses real, present data; player-level would not.
5. `npx tsc --noEmit` and `npm run lint` clean.

**Skills for this task:** the `ui-ux-pro-max` skill (mandatory).

---

## Team D: `ui-pass/power-user` (2 employees)

### Employee D1: `command-palette`

**Files:** Create: `web/app/components/command-palette.tsx`. Modify `web/app/layout.tsx` (mount it globally). Modify `web/components/ui/` (add shadcn `command`/`dialog` components via `npx shadcn@latest add command dialog`).

**Task:**
1. Run `ui-ux-pro-max` queries before implementing: `"command palette keyboard"` and `"cmd k quick navigation"` (`--domain ux`), plus `"command palette"` (`--stack nextjs`).
2. Build a global ⌘K (and Ctrl+K on non-Mac) command palette using shadcn's `Command`/`Dialog`. Sections: **Navigate** (Home/Live Board/Quality Scorecard/Historical Explorer), **Actions** (toggle theme — reuse the existing `useTheme()` call from `theme-toggle.tsx`; toggle density — call whatever function/hook Employee D2 exposes, coordinate via the boss if D2 hasn't merged yet, or stub it behind a clearly-marked TODO comment referencing D2's task if genuinely blocked), and **Games** (fuzzy search over real games by team name).
3. **Per the Global Constraints' shared-data-contract decision: fetch games for the palette search directly from the existing `/api/games` BFF route** (the same one Explorer already calls) — do not import or depend on anything Employee C1 builds. This is deliberate, not a shortcut: it's what removes the cross-team collision risk between D1 and C1 identified during planning.
4. Selecting a game result navigates to `/explorer` with that game identified (e.g. a query param `?game_id=`) so Employee C2's expansion pattern (if merged) or a simple scroll-to-and-highlight can pick it up — coordinate the exact param name with the boss if C2's PR shape isn't settled yet, but don't block on it; a bare navigation to `/explorer` is an acceptable fallback if C2's game-detail affordance isn't ready.
5. `npx tsc --noEmit` and `npm run lint` clean. State plainly which parts need a real browser (actual ⌘K keybinding capture, actual fuzzy-match ranking feel) vs. what's verifiable now (the component renders, the game list is fetched and rendered, navigation fires).

**Skills for this task:** the `ui-ux-pro-max` skill (mandatory).

### Employee D2: `keyboard-shortcuts-and-density`

**Files:** Create: `web/app/components/keyboard-shortcuts.tsx` (or a hook, e.g. `web/lib/use-keyboard-shortcuts.ts` — your call, document which and why). Modify `web/app/layout.tsx`, `web/app/globals.css` (density-driven spacing token overrides). Depends on Employee B1's `web/lib/local-store.ts` for persisting the density preference — same coordination note as B2.

**Task:**
1. Run `ui-ux-pro-max` queries before implementing: `"keyboard shortcut sequence"` and `"information density compact mode"` (`--domain ux`), plus `"density spacing tokens"` (`--domain ux` if that returns nothing relevant, retry with `--domain ux` narrower terms per the skill's retry guidance — do not accept an off-topic result silently).
2. GitHub-style sequential nav shortcuts: `g` then `l`/`q`/`e`/`h` navigate to Live/Quality/Explorer/Home respectively. A `?` key opens a shortcuts-help overlay listing every shortcut.
3. **Every shortcut handler must check that focus is not currently inside a text input, textarea, or contenteditable element before acting** — this is stated twice in this plan deliberately (Global Constraints and here) because it is the single easiest thing to forget and the one that would most visibly break Explorer's player-name search and B1's saved-search-label input.
4. A comfortable/compact density toggle (exposed for D1's command palette to call, per D1's step 2), persisted via `local-store.ts`, adjusting spacing tokens on tables and cards in `globals.css` (add new CSS custom properties for spacing rather than hardcoding two full parallel stylesheets).
5. `npx tsc --noEmit` and `npm run lint` clean. State plainly that actual keypress-sequence behavior and the visual density difference need a real browser to fully confirm, though the guard logic (input-focus check) is unit-testable-by-inspection at minimum.

**Skills for this task:** the `ui-ux-pro-max` skill (mandatory).

---

## Verification (all four bosses, before reporting to the human)

- `web`: `npx tsc --noEmit`, `npm run lint`, `npm run build` all clean on the fully-merged boss branch.
- No Python service is touched by Teams B/C/D — only Team A touches `api/`, and its existing suite (76 tests before this plan) plus new tests for `/quality/history` must stay green.
- **What is honestly verifiable in a sandbox, per team, without a live browser:** Team A's endpoint (real tests, real assertions), Team C's sort/filter logic (pure client-side, testable over fixture data), the existence and wiring of Team B/D's components (`tsc`/`lint` clean, code reads correctly). **What is NOT verifiable without the human's real Chrome pass:** any chart's actual visual rendering (A2), `localStorage` persistence surviving a real reload (B1, B2, D2's density setting), the command palette's actual ⌘K capture and fuzzy-match feel (D1), and real keyboard-shortcut behavior including the input-focus guard actually working end-to-end (D2). Every boss must state this split explicitly in its final report — do not let a global "sandbox has no browser" caveat mentioned once get lost across four parallel reports.
- After all four branches integrate, the human will do a real Chrome walkthrough (matching Week 6's established practice) covering every item in the "NOT verifiable without a live browser" list above, plus a live-run of the quality checks against real Postgres to confirm `/quality/history` returns real data once it exists.

## Execution

All four boss branches are created and their teams dispatched in parallel immediately after this plan is saved. Each boss verifies its own worktree isolation actually took (`git worktree list` shortly after starting) before proceeding, per the process gap found and documented during the Week 5 round. The human sign-off gate remains the final merge into `main`.
