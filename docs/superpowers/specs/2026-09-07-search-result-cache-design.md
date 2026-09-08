# Search Result Cache — Design

## Context

The Statmuse-style NL stats search feature (`web/app/api/search/route.ts`,
`web/lib/search-loop.ts`, `web/lib/search-tools.ts`) exists on unmerged
feature branches (`story2/bff-search-route`, `story3/search-page-ui`,
`origin/worktree-search-result-tables`) but not yet on `main` or this
branch. Every request runs a fresh LLM tool-use loop, even for a question
that was just asked. This spec adds a cache in front of that loop so a
repeated question is served without a new LLM call, and is written against
the feature as it exists on `origin/worktree-search-result-tables` today —
implementation lands wherever that feature actually merges.

`REDIS_URL` is already reserved in `.env.example` ("Redis (caching, week
4+)"), and PRD §9 already calls for "a small Redis ... cache in front of
`/live` and `/quality`" with a **live-freshness SLA of <30s**. This feature
is the first real use of that planned cache, and its live-bucket TTL is
deliberately set to match that existing documented SLA rather than an
arbitrary number.

## Goals

- A repeated (near-identical text) search question is answered without a
  new LLM call, for both successful and "no data"/"ambiguous" outcomes.
- Cache freshness is derived from what the search loop actually learned
  about the query (whether its answer's date range is live or historical),
  not a single flat TTL applied to everything.
- Zero behavior change for the client on a cache hit — same SSE wire
  protocol, same `done` event shape (plus two additive metadata fields, see
  below).
- Redis being slow or unavailable degrades to "no caching," never to a
  broken or slower search response than today.

## Non-goals (explicit deferrals)

- **Semantic/embedding-based near-duplicate matching.** v1 keys on exact
  normalized question text only. "who leads in scoring" and "Who leads in
  scoring?" are different cache keys — see Known Limitation below.
- **Cross-user cache warming or pre-fetch.**
- **Event-driven (dbt/Prefect-triggered) invalidation.** The natural v2
  evolution once a scheduled/triggered dbt run exists to publish a "Gold
  refreshed" signal from; today `dbt run` is manual, so there is nothing to
  hook into.
- **Frontend UI treatment of a cache hit** (e.g. a "cached" badge). The
  `cached`/`cachedAt` metadata is added to the wire contract so it *can* be
  surfaced later, but no `search-section.tsx` change is in scope here.

## Architecture

```
POST /api/search
  │
  ▼
normalize(question) ──► cacheKey = "search:v1:" + sha256(normalized)
  │
  ▼
searchCache.get(cacheKey)  (web/lib/search-cache.ts)
  │
  ├─ hit  ──► stream cached {answerText, citation, noData, candidates,
  │           resultData} through the existing sseTextChunk/sseDone path,
  │           with cached: true, cachedAt: <iso> added to the done payload.
  │           No LLM call, no FastAPI tool call.
  │
  └─ miss ──► runSearchLoop(...) as today
              │
              ▼
              start streaming the real result immediately (unchanged)
              │
              ▼ (fire-and-forget, not awaited — see "Non-blocking write")
              searchCache.set(cacheKey, result, ttl(result))
```

`web/lib/search-cache.ts` is a new module wrapping a Redis client (the
`redis` npm package, added to `web/package.json`, using `REDIS_URL`). Its
public interface (`get(key)` / `set(key, value, ttlSeconds)`) takes an
injectable client, matching the DI pattern `search-loop.ts` already uses
for `LlmClient`/`callTool` — tests use an in-memory fake, never a real
Redis connection, per this repo's offline-verification convention.

## Cache key & value

- **Key:** `search:v1:<sha256 hex of normalized question>`. Hashing keeps
  keys fixed-length and keeps raw user text out of Redis key names. The
  `v1` segment lets a future key-shape change (e.g. adding semantic
  bucketing) coexist with or cleanly replace old entries.
- **Normalization:** `question.trim().toLowerCase().replace(/\s+/g, ' ')`.
- **Value (JSON):**
  ```ts
  {
    answerText: string;
    citation: Citation | null;
    noData: boolean;
    candidates: string[] | null;
    resultData: SearchResultData | null;
    cachedAt: string; // ISO timestamp, set at write time
  }
  ```

### TTL bucketing needs a machine-readable date, not `citation.dateRange`

`Citation.dateRange` (per `search-tools.ts`'s `deriveDateRange` /
`formatDateRange`) is already a human-formatted display string built for
the answer's citation line — not something the TTL logic should parse
back into a date. `deriveDateRange` computes real ISO date values
internally (`dates[dates.length - 1]` for `get_player_stats`/
`get_team_games`, `end_date` for `get_leaders`, `rowDate(payload.game)`
for `get_game_result`) before formatting them away. This spec adds one
small additive field to carry that raw value through server-side only:

- `ToolResultEnvelope` gains `date_range_end_iso: string | null` (the raw
  ISO end date, computed alongside — not instead of — the existing
  formatted `date_range`).
- `SearchResult` (in `search-loop.ts`) gains `citationEndDateIso: string |
  null`, threaded through `finalize()` the same way `citation` already is.
- This field is used **only** by `search-cache.ts`'s TTL-bucketing
  function in `route.ts`, immediately after `runSearchLoop` returns. It is
  **not** added to the `sseDone()` payload — the wire contract's only
  additions stay `cached`/`cachedAt` (see TTL policy below), keeping the
  client-facing change minimal.

### Known limitation: normalization is text-exact, not semantic

Punctuation, trailing "?", and phrasing differences are not normalized
away in v1. "who leads in scoring" and "Who leads in scoring?" produce
different cache keys and both hit the LLM independently. This is an
accepted v1 scope cut (see Non-goals), not a bug — but it means the raw
hit-rate counters (see Observability) will read lower than a semantically
deduplicated cache would achieve, and that gap should be understood before
treating a "low" hit rate as a problem to fix.

## TTL policy

Decided **after** `runSearchLoop` returns, from the result itself — not
guessed from the question text up front:

| Outcome | TTL | Rationale |
|---|---|---|
| `noData: false`, has a `citation`, and `citationEndDateIso` is **today** (America/New_York — see Timezone dependency below) | **30s** | Matches PRD §9's own live-freshness SLA exactly. Covers in-progress-game queries and every `get_leaders` call, since that tool has no date param and its derived range always ends today. |
| `noData: false`, has a `citation`, and `citationEndDateIso` is fully in the **past** | **6 hours** | Long enough to skip the LLM for the large majority of repeat historical questions; bounded (not permanent) to cap staleness risk from a `backfill_checkpoints`-driven correction landing mid-window — see below. |
| `noData: false`, has a `citation`, but `citationEndDateIso` is `null` (malformed/unparseable tool data) | **15 minutes** | Falls back to the same conservative bucket as a no-citation outcome rather than guessing live vs. historical. |
| `noData: true` or `candidates` present (ambiguous) | **15 minutes** | No date range to reason about, but still deterministic against current Gold data; a flat, moderate window bounds staleness without special-casing. |
| Provider/infra error (`event: error`) | **not cached** | Always retried — a transient failure must never be memoized. |

**`get_leaders` always gets the 30s bucket, including on days with no live
games.** This is intentional, not an accidental side effect of the
date-range rule: there's no way to distinguish "off-day" from "day with a
live game" from the tool's output alone, and the cost of treating every
leaderboard query as live is a few extra LLM calls on quiet days — not a
correctness problem, since leaderboards rarely move without a completed
game anyway.

### Historical-bucket staleness and `backfill_checkpoints`

If a backfill correction lands mid-window, a cached historical answer can
serve the pre-correction value for up to 6 hours with no active
invalidation (accepted v1 risk — event-driven invalidation is the v2 fix,
see Non-goals). To keep that debuggable rather than silent, `cachedAt` is:

- always stored in the cached value (already listed above), and
- always included in the `done` SSE event, as two new additive fields:
  `cached: boolean` and `cachedAt: string | null` (`null` on a fresh, non-cached
  answer). This is a wire-contract addition to `SearchResult`/`sseDone()`,
  not a new endpoint — `search-stream.ts`'s parser must accept and ignore
  these fields defensively, same style as its existing handling of
  `citation`.

This means a "why did it say X" debugging session has a fast answer
(check `cachedAt` against when the correction landed) without requiring
any new UI.

## Non-blocking cache write

The route must **start streaming the real result to the browser before**
attempting the cache write, and the write itself is fire-and-forget (not
`await`ed) inside the same fail-open try/catch as reads. Awaiting a Redis
write before streaming would add Redis's latency to every cache-miss
request — worse than not caching at all for that request — and would eat
directly into the 30s live-freshness budget the TTL policy is built
around. The write only benefits *future* requests, so it must never gate
the response to *this* one.

## Timezone dependency: "today" needs one shared helper

The live-bucket boundary ("`citationEndDateIso` is today, in
America/New_York") is the same "what counts as today" question already
flagged as an open gap for `live_game_state` grouping (the board/commentary
work). No canonical "today in ET" helper exists in `web/` today (checked:
`recent-games-board.tsx` currently formats dates in UTC, not ET). This
spec does **not** independently invent its own ET boundary check — it
depends on a single shared helper (e.g. `web/lib/date/nba-today.ts`,
exact location TBD by whichever feature lands first) that both this cache
and the live-game grouping feature call into. Whichever implementation
plan lands first should create that helper; the other must reuse it
rather than writing a second, independently-drifting ET boundary check.
This is called out explicitly so the two features don't silently disagree
about whether a post-midnight-UTC game is "live" or "historical" on the
same night.

## Error handling (fail-open)

Redis is an optimization, never a dependency. Any error from
`searchCache.get()` or `searchCache.set()` (connection refused, timeout,
malformed cached JSON) is caught and logged inside `search-cache.ts`
itself, and treated as a miss (for `get`) or a no-op (for `set`). The
route code calling into `search-cache.ts` never needs its own try/catch —
the module's public interface simply cannot throw.

## Observability

- `search_cache_hit_total` / `search_cache_miss_total` counters (Redis
  `INCR`, or in-memory if simpler for v1 — either is fine since this is
  informational, not load-bearing).
- Each request logs hit/miss and which TTL bucket applied (`live` /
  `historical` / `no-citation`), consistent with the existing
  `console.error`-only logging style in `route.ts`.
- A cost/$-saved dashboard on top of these counters is a natural follow-up
  feature, not built here.

## Testing

Following this repo's offline-verification convention (CLAUDE.md
Testing section):

- `search-cache.ts` is unit-tested against an in-memory fake Redis client
  (get/set/TTL behavior, fail-open on a thrown error from the fake).
- `route.ts`'s cache-hit and cache-miss paths are unit-tested by injecting
  a fake `searchCache` the same way it already injects `getLlmClient`/
  `runSearchLoop` — no real Redis, LLM, or FastAPI call in any test.
- TTL-bucket selection (`live` / `historical` / `no-citation` / `error`) is
  tested as a pure function taking a `SearchResult` and a "now" timestamp,
  independent of Redis, so date-boundary edge cases (a game ending just
  before/after midnight ET) are cheap to cover without mocking time
  globally.
