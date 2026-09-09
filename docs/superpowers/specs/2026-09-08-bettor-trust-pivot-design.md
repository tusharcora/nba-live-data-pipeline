# Bettor-trust pivot: Phase A design

Source of truth for this feature. Grew out of a brainstorming conversation
reviewing the whole product; see that conversation for the rejected
alternatives (see §8) if this doc and memory ever disagree, this file wins
for implementation purposes.

## 1. Decisions this spec is built on

Made explicitly during brainstorming, not re-litigated here:

- **Goal: real product, real users** — not a portfolio-only exercise anymore
  (though it still needs to work as one; nothing here removes that).
- **Target user: serious bettors / sharp fans** — people who've been burned
  by a wrong live score or a stale stat and actually care whether a number
  is right, not the general "watch scores" fan (who has ESPN/theScore and
  no reason to switch) or the fantasy player (different pitch entirely,
  not excluded by this work but not who it's written for).
- **Odds/lines are explicitly out of scope.** The product stays box-score
  and live-game-state only. The pitch to a bettor is "trust the data you
  already act on" (final scores, live clock/score state, player stats),
  not "come here for lines" — no new data source, no new ingestion work.
- **This is Phase A of a three-phase plan** (see the brainstorming
  conversation): ship & surface what already exists (this doc) → build a
  self-healing detect→repair loop + source-reliability scoring (Phase B,
  not designed here) → a public proof-of-trust distribution layer (Phase
  C, not designed here). Phase A was chosen to go first because, per the
  audit below, most of the hard backend work already exists — this phase
  is disproportionately cheap for its payoff.

## 2. Audit: what's already built vs. what's actually missing

This matters because the original brainstorm assumed more work was needed
here than turned out to be true — worth stating plainly so Phase A doesn't
re-build things that exist.

**Already real, already live, do not rebuild:**

- **Live-board conflict/staleness detection** (`api/src/api/routers/board_commentary.py`).
  Every live game's board row already gets one rule-based commentary line
  computed from real `source_conflicts` and `live_game_state` rows — kind
  `"conflict"` when two sources currently disagree on a field (re-checked
  against live values, not a stale snapshot), kind `"stale"` when the
  primary source (`nba_stats`) hasn't polled recently. `FeedTicket`
  (`web/app/components/feed-ticket.tsx`) already renders this with a
  distinct color (`COMMENTARY_COLOR`, pink for conflict, amber for stale).
- **The Quality page's conflicts table** (`web/app/quality/quality-tables.tsx`'s
  `SortableConflictsTable`, backed by `GET /quality`'s `conflicts.recent`
  array). Structurally real and sortable, **but has a live bug**: the API
  serializes the key as `field_name` (`quality.py::_serialize_conflict`),
  while the frontend's `Conflict` type (`quality-shared.tsx`) and
  `SortableConflictsTable` both read `conflict.field` — so the Field
  column always renders "–" in production today. Fix this as part of
  Phase A (§6 reuses this same data for the new recent-catches feed, and
  must not copy the same key mismatch into it).
- **The NL search feature itself** (`/search`, `search-section.tsx`,
  `search-loop.ts`, `search-tools.ts`, the `/tools/*` FastAPI router in
  `query_tools.py`). Live, wired into nav, previously verified end-to-end
  with real questions and citations. (This spec's brainstorming
  conversation initially believed this was unmerged — it isn't; that was
  stale information. Confirmed current on this branch before writing this
  doc.)

**Real, confirmed gap — this is what Phase A actually builds:**

1. **Search answers never mention a live source disagreement.**
   `query_tools.py`'s tool readers (`GameResultToolReader`,
   `PlayerStatsToolReader`, etc.) never query `source_conflicts`, and
   `search-tools.ts`/`search-loop.ts` have no conflict-awareness at all
   (confirmed: zero matches for `conflict`/`SourceConflict` in either
   file). So a bettor can ask "what was the score" and get a confidently
   stated number even when that exact field has an open, recent
   `source_conflicts` row for that game — the single most bettor-relevant
   trust gap in the product.
2. **None of the above is positioned for a bettor.** The homepage
   (`web/app/page.tsx`) is a ticker, a game board, and two sentences about
   medallion architecture — written for a hiring manager skimming
   architecture, not a fan deciding whether to trust a score. `/quality`
   reads as an internal engineering dashboard (raw metric names, PSI
   scores) with no framing of why a bettor should care or come back to it.
3. **Nothing turns a real caught conflict into something worth returning
   for.** No changelog/feed framing of "here's what we caught and fixed
   recently" — everything is presented as live-only tables, nothing
   persists as a trust narrative a returning user would check.

Gaps 2 and 3 are copy/presentation work over data that already exists.
Gap 1 is the one real code change.

## 3. Scope

### In scope (Phase A)

- Extend the NL search path to surface known source disagreements in its
  answers, grounded in real `source_conflicts` rows (never fabricated).
- Rewrite the homepage to lead with the trust pitch instead of burying it
  in a footer sentence.
- Reframe `/quality` as a bettor-facing "Trust Center": same real data,
  restructured and re-copy'd to answer "can I trust today's data," with a
  changelog-style recent-catches view added.
- Add a small, real "recent catches" feed (schema changes + conflicts,
  merged chronologically) as the Trust Center's headline content, above
  the existing detailed tables (which stay, for anyone who wants the raw
  numbers).

### Out of scope (explicitly, for this phase)

- Odds/lines data (decided in brainstorming — stays out entirely).
- The self-healing repair loop and source-reliability trust scoring
  (Phase B) — this phase surfaces conflicts, it doesn't act on them beyond
  the existing "primary wins" resolution rule already in place.
- Any public distribution/growth mechanism — a proof-feed bot, a public
  leaderboard, social posting (Phase C).
- Any monetization, auth, multi-tenant API access, or billing work. The
  API stays a private BFF-gated backend; "API as a product" is not part of
  this phase.
- Personalization/accounts — no login system exists; nothing here adds
  one.
- Mobile-specific redesign beyond what already exists — no new responsive
  work scoped here.

## 4. Feature 1: conflict-aware search answers

### 4.1 Where the check happens

**Decision: embed the conflict check inside each existing tool's backend
response, not as a separate callable tool the model has to decide to
invoke.** A new `check_data_confidence` tool the LLM *could* call is
strictly weaker — nothing forces the model to call it, and `search-loop.ts`'s
"never state a fact your tools didn't return" rule only protects against
fabrication, not omission. Embedding the flag directly in
`get_game_result`'s and `get_player_stats`'s existing response means the
model sees it on every relevant answer whether or not it thinks to ask.

### 4.2 Backend change (`api/src/api/routers/query_tools.py`)

For the two tools whose answers are scores/box-score fields directly
exposed to a bettor (`get_game_result`, `get_player_stats` — not
`get_leaders`/`get_player_stat_aggregate`/`get_player_streak`, which
aggregate across many games and don't map cleanly to one open conflict
row):

- `GameResultToolReader.get_game_result` gains a lookup against
  `source_conflicts` for that resolved `game_id`, scoped to fields that
  are actually part of the tool's own answer (`home_score`, `away_score` —
  not e.g. an internal field the answer never surfaces). Modeled on
  `quality.py`'s existing `QualityReader.recent_conflicts_for_game(game_id,
  window_seconds)` but not reused directly: that method's
  `window_seconds` cutoff exists for the live board's 5-minute display
  window (`CONFLICT_DISPLAY_WINDOW_SECONDS`), which doesn't apply here —
  search answers cover historical games, not just live ones, so this
  needs an unwindowed "every conflict ever logged for this game" query
  instead. Add it as its own method on a new/extended reader rather than
  overloading the existing one with an optional window param that only
  one caller ever omits.
- `data_confidence` lives **inside the tool's existing `data` object**,
  not as a new top-level sibling of `status`/`data`/`candidates`/`message`
  — `query_tools.py`'s shared `_ok()` builder documents every route as
  returning exactly one of a fixed set of top-level shapes, and other
  optional extras (`date_range`, `matching_games_truncated`) already live
  inside `data` rather than as new top-level keys. This is a deliberate
  choice, not left to the implementer.
- Response gains an optional `data_confidence` field on `data`, present
  only when a relevant conflict exists:
  ```json
  "data_confidence": {
    "field": "home_score",
    "note": "balldontlie and nba_stats disagree on this value; showing balldontlie's number.",
    "primary_source": "balldontlie",
    "primary_value": "103",
    "secondary_source": "nba_stats",
    "secondary_value": "101"
  }
  ```
  Omitted entirely (not `null`) when no conflict exists — keeps the
  common case's payload unchanged, matches this codebase's existing
  "absent means nothing to report" convention (e.g. `/board`'s
  `commentary: null` for non-live rows uses `null` because the field is
  always present in that shape; here the field is genuinely optional
  since most tool calls will never need it).
- `get_player_stats` gets the same treatment scoped to whichever
  numeric fields that tool actually returns (points/rebounds/assists/etc.)
  against `source_conflicts` rows for that `(game_id, player)`'s
  underlying game.

### 4.3 Frontend change (`web/lib/search-tools.ts`, `search-loop.ts`, `search-result-tables.tsx`)

- `search-tools.ts`'s `deriveResultData()` must be updated to copy
  `data_confidence` from the raw tool payload into `GameResultResultData`/
  `PlayerStatsResultData` (`web/lib/search-result-types.ts`, where both
  types also need the new optional field added). `SearchResultDataView`
  (`search-result-tables.tsx`) renders strictly off these typed
  `SearchResultData` shapes with no generic envelope passthrough, so
  without this step the badge cannot appear on a result card no matter
  what the backend returns — this touches three files
  (`search-result-types.ts`, `search-tools.ts`, `search-result-tables.tsx`),
  not the two originally implied.
- **Known limitation, not fixed in this phase**: `search-loop.ts::finalize()`
  suppresses `resultData` entirely whenever a turn dispatches 2+ tool
  results (its documented multi-subject-comparison boundary). A
  comparison question that happens to trigger this still gets a prose
  answer that can mention the disagreement (the model sees `data`
  either way), but the visual badge won't render on that turn. Accepted
  as-is; revisit only if this turns out to matter in practice.
- `search-loop.ts`'s system prompt gains one explicit instruction: when a
  tool result includes `data_confidence`, the answer must state the
  disagreement plainly (mirroring board commentary's existing tone,
  e.g. "sources disagree on the final score here — showing X, Y also
  reported Z") rather than silently picking a number. This is a narrow,
  additive instruction to the existing "never state a fact your tools
  didn't return" prompt section, not a rewrite of it.
- `search-result-tables.tsx` gets a small inline badge/footnote on any
  result card carrying `data_confidence` — visually distinct (reuse the
  existing pink "conflict" treatment from `COMMENTARY_COLOR` for visual
  consistency with the live board, not a new color language).

### 4.4 Testing

Follows this project's existing pattern exactly (see `search-tools.test.ts`,
`search-loop.test.ts` for the shape to extend):

- `query_tools.py`: `GameResultToolReader`/`PlayerStatsToolReader` are
  `@runtime_checkable` Protocols with existing fakes in
  `api/tests/test_query_tools.py` — adding a new conflict-lookup method to
  either Protocol means updating every existing fake to implement it too,
  or any existing test path that now reaches the new call breaks. Do this
  update first, before writing new tests, not as a side effect discovered
  by a failing test run.
- Then: a fake test double returning a conflict row, asserting
  `data_confidence` appears with correct field mapping; a no-conflict case
  asserting the field is absent (not `null`, not an empty object).
- `search-tools.test.ts`: envelope normalization passes `data_confidence`
  through unchanged.
- `search-loop.test.ts`: a fake tool result carrying `data_confidence`
  produces a finalized answer that actually mentions the disagreement —
  this is the one behavior worth a real assertion here, since a prompt
  instruction with no test is exactly the kind of thing that silently
  regresses later.

## 5. Feature 2: homepage rewrite

Current `web/app/page.tsx`: `SiteHeader` → `RecentGamesBoard` →
`Separator` → two sentences of footer copy about medallion architecture.

Change: move the trust pitch out of the footer and into a real hero
section between the header/ticker and the game board — a short, bettor-
facing headline and one supporting line, e.g. (copy to be refined during
implementation, not locked here):

> **We tell you when the data disagrees with itself.**
> Every score comes from two independent sources. When they don't match,
> you see it — not a quietly-picked number.

with a link into the Trust Center (§6). The existing footer sentence about
Prefect/dbt/FastAPI stays as-is, further down — that's still accurate
context for anyone curious, it just isn't the first thing a visitor reads.
No structural/component change beyond adding this one new section — this
is a copy and layout change, not new data-fetching.

## 6. Feature 3: `/quality` → Trust Center

Keep the existing route (`/quality`) and all existing components
(`quality-shared.tsx`, `quality-tables.tsx`, `quality-charts.tsx`) — this
is a reframe, not a rebuild.

Changes:

- **Page copy and nav label**: rename the nav entry from "Quality" to
  something bettor-legible ("Trust Center" or similar — finalize during
  implementation) and rewrite the page's leading copy to answer "can I
  trust today's data" in plain language before showing any raw metric.
- **New "recent catches" feed**, placed above the existing detailed
  tables: merges `schema_changes` and `conflicts.recent` (both already
  returned by `GET /quality`) into one reverse-chronological list. This
  is a new frontend-only merge/format function over data both endpoints
  already return — no new API endpoint needed — but the format function
  needs to handle real cases the obvious example doesn't cover:
  - **Conflict entries**: the copy must be built from `primary_source`
    (e.g. "resolved using balldontlie") — `resolution` is **not** a
    source label, it's the winning *value* itself
    (`quality/reconciliation.py` sets `resolution = primary_value`).
    Using `resolution` where a source name is expected would render the
    winning number instead of who won.
  - **Schema-change entries, all three `change_type`s**, not just
    `added`: `SchemaChangeLog.change_type` is `added` / `removed` /
    `type_changed` (`quality/fingerprint.py`), and the app already treats
    these with different severity elsewhere (`schemaChangeBadgeVisual`:
    added=secondary, removed=destructive, type_changed=outline). A
    `removed` field is materially more concerning than an `added` one (it
    can silently break downstream parsing) and the copy should say so,
    not use one generic "no action needed" line for all three.
- The existing `SortableConflictsTable`, schema-change table, and PSI/
  agreement-rate charts stay exactly as they are, below the new feed, for
  anyone who wants the raw detail — this is additive, not a replacement.

## 7. Rollout order

1. Backend: `data_confidence` on `get_game_result`/`get_player_stats`
   (§4.2), with tests.
2. Frontend: thread `data_confidence` through search (§4.3), with tests.
3. Homepage rewrite (§5) — independent of 1-2, can happen in parallel.
4. Trust Center reframe + recent-catches feed (§6) — independent of 1-2,
   can happen in parallel.

No sequencing dependency between the search work (1-2) and the
homepage/Trust Center work (3-4) — safe to build as two parallel tracks.

## 8. Explicitly deferred (do not build in this phase)

- Phase B: self-healing targeted re-pull on conflict detection, and a
  source-reliability score replacing the current fixed "primary wins"
  resolution rule. Needs real conflict volume to validate against, which
  this project has historically had very little of — worth checking
  actual `source_conflicts` row counts before scoping Phase B for real.
- Phase C: any public/social distribution mechanism for real catches.
- Odds/lines as a data source (explicitly rejected in brainstorming).
- API productization (public keys, billing, docs portal, usage tiers).

## 9. Blocking finding: §4's premise needs a decision before implementation

An adversarial subagent review of this spec (2026-09-08) plus a direct
check against the real local database surfaced a problem serious enough
to resolve before writing code for §4, not during implementation:

**The id-space mismatch is real and broader than originally scoped.**
`source_conflicts.game_id` is written by exactly one production path —
`ingestion/flows/live_game_flow.py::reconcile_live_states` — as
**nba_stats's own unoffset id** (e.g. `"22500123"`). Gold `games.game_id`
(what `get_game_result`/`get_player_stats` actually key off) is a union of
two disjoint id spaces with no `source` column to tell them apart:
balldontlie's native (unoffset) id, and nba_api-backfilled games offset by
`NBA_GAME_ID_OFFSET` (100,000,000,000). So the join needs an
undocumented "subtract the offset" step for nba_api-sourced Gold games —
and for a **balldontlie-sourced** Gold game, there is no persisted mapping
back to nba_stats's id space at all; nothing this codebase writes today
recovers it. This affects `get_game_result` (the tool that returns the
literal score this whole pitch is about) exactly as much as it affects
`get_player_stats`, not just the latter as originally flagged.

**Worse: as of this review, the relevant tables are empty in the real
database**, independent of the id-space question —
`SELECT count(*) FROM source_conflicts` returns **0**, and so do
`schema_change_log`, `quality_metrics`, and `live_game_state` (checked
directly against the local Postgres instance, not inferred). `games` has
38,002 real rows (backfills work), but nothing that generates a trust
signal currently has any real rows to generate from. This matches this
project's own recurring, previously-documented pattern (see project
memory: `quality_metrics`/schema-drift checks have never had a
meaningful volume of real dual-source live-polling data to work from) —
it isn't a new problem, but it means **§4 as designed will ship
correct, tested code that has nothing real to surface in production
today**, and §6's "recent catches" feed will render empty for the same
reason.

For a portfolio piece, "correctly built, dormant until real data
accumulates" was this project's established and accepted pattern (see
`player_game_stats`' months-long empty period, the shelved win-probability
model). **For a real product aimed at bettors, a trust feature that never
visibly fires is a much bigger problem** — it's the one thing meant to
make a first-time user believe the pitch, and it would currently show
nothing.

**This needs a decision, not an assumption, before §4 is implemented:**
does Phase A also need "get real dual-source live polling running
consistently enough to produce real `source_conflicts`/`schema_change_log`
rows" as an explicit prerequisite (a data-operations task, not a code
task) — or does Phase A ship as designed and accept it will look inert
until that data exists, same as this project has always handled data
gaps? This also determines whether it's worth fixing the id-space gap now
(e.g. adding a `source` column to Gold `games`, or persisting the
nba_stats-space id at ingestion time for balldontlie-sourced games) or
deferring it until there's real conflict volume to actually join against.

## 10. Other open questions

- Exact wording for the homepage hero and Trust Center copy is left
  loose above (marked "to be refined") — worth a real pass during
  implementation rather than locking it in a spec no designer/copywriter
  has looked at.
