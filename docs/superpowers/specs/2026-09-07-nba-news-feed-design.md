# NBA News Feed (Phase 1) — Design

## Context

The user asked for a "Shams post bot": whenever NBA insider Shams Charania
posts on Instagram, that post (image + caption) should appear on the
site's news page and also be ingested as a source the NL search feature
(`web/lib/search-tools.ts`/`search-loop.ts`) can answer questions from.

Meta's official APIs were researched first, directly, not assumed.
Instagram Basic Display API is deprecated and only ever worked for an
app's own authorized account. The Instagram Graph API's Business
Discovery endpoint — the one feature that can query another public
Business/Creator account without its owner's permission — was checked
directly against Meta's own developer docs; it only returns profile-level
stats (follower/media counts) plus, per post, a bare ID and engagement
counts. Meta's own docs state a `GET` on that returned media ID fails
with insufficient permissions. **There is no free, official path to
another account's actual post content (image + caption).** Real content
would require an unofficial scraper, an RSS-bridge, or a paid third-party
monitoring API (Apify, Bright Data, etc.) — a materially different, more
fragile, and more ToS-risky undertaking than anything else in this
project.

Given that gap, this spec covers **Phase 1 only**: a general NBA news feed
sourced from ESPN's public news API, extended with a real reporter/byline
filter (see below) that gets a legitimate "Shams feed" capability without
touching Instagram at all. **Phase 2** — an actual Instagram-capture
pipeline for posts ESPN never publishes under his byline — is deferred as
its own future spec, the same "prove the simpler thing first" sequencing
this project already used for the `nba_api` historical backfill before
building Statmuse search on top of it.

## Findings (empirically verified during design, not assumed)

- A real `GET https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news`
  returned **HTTP 200 with real JSON**, verified directly from this
  environment on 2026-09-07 — no cloud-IP blocking observed (see "ToS /
  bot-detection note" below for the correction this makes to an earlier
  design pass).
- Real per-article fields (verified against the live response, not
  guessed): `id` (a stable numeric article ID), `headline`, `description`
  (a short dek/summary — **not** the full article body, which this
  endpoint never returns), `byline` (a string — see next point),
  `published` / `lastModified` (ISO timestamps), `images[]` (`url`,
  `credit`, sometimes `caption`), `categories[]` (includes a
  `type: "contributor"` entry mirroring `byline`, plus `team`/`league`
  tags), `links.web.href` (the canonical article URL).
- **`byline` is populated at the individual-reporter level**, not just a
  generic placeholder — a real pull returned `"Marc J. Spears"`,
  `"Anthony Gharib"`, `"Sach Chandan"` alongside generic values like
  `"NBA Insiders"` and `"ESPN"` on other articles. Shams Charania has been
  an ESPN NBA Insider since 2023, so his bylined articles plausibly appear
  in this same feed under `byline: "Shams Charania"` (or similar) when he
  authors one.
- A single request returns a **rolling window of the most recent articles**
  (6 observed in one real pull), not a paginated archive — matches the
  "live headline feed, not a historical archive" framing already used
  elsewhere in this project for similar live sources.

## Goals

- New NBA news (general, or specifically reporter-attributed) is visible
  on a new `/news` page: headline, short summary, byline, link to the
  original ESPN article.
- The same content is queryable through the existing NL search feature via
  a new `get_recent_news` tool, following the same citation/no-guessing
  discipline (CAP-4/CAP-5) the existing four tools already use.
- A reporter/byline filter exists on both the page and the search tool, so
  a "Shams feed" (or any other insider's) is a real, working filter over
  real data — not a promise deferred entirely to Phase 2.
- No re-publishing/copyright exposure beyond an explicitly-chosen,
  industry-standard aggregation pattern (see below).

## Non-goals

- **Instagram capture, Meta Graph API integration, or third-party
  scraping (Apify, Bright Data, etc.)** — investigated above; there is no
  free/official path to another account's post content. A real
  Instagram-capture pipeline (Phase 2) is deferred as its own future spec.
- **Semantic/vector search over news content** — reuses the existing
  typed tool-calling pattern; no new embedding infrastructure.
- **Deep historical news backfill** — the endpoint is a rolling live feed,
  not an archive; there is nothing meaningful to backfill.
- **Full-article reproduction or image re-hosting** — only the headline
  and ESPN's own short `description` are shown, with a prominent link-out;
  never the article body, never ESPN's photography (see "Content
  reproduction & attribution" below).
- **A byline-based Phase 1 filter closing the Instagram gap entirely** —
  it only surfaces news ESPN itself has published under a given byline
  (see "Reporter/byline filter" below for the named limitation).

## Architecture

```
ESPN public news endpoint
(site.api.espn.com/apis/site/v2/sports/basketball/nba/news)
  │  GET, no auth — verified reachable from this environment (Findings)
  │
  │  new Prefect flow: ingestion/src/ingestion/flows/news_flow.py
  │  periodic schedule (~15 min) — see "Freshness" below
  ▼
raw_pulls(source="espn", endpoint="news",
          payload=<the full {"articles": [...]} response, verbatim>)
  │  ONE raw_pulls row per poll holding the whole batch — matching
  │  PublicFeedClient/live_game_flow's existing "one row, whole batch"
  │  shape, not a new one-row-per-article convention
  │
  │  new dbt staging model: stg_news_articles.sql
  │  unnests payload.articles (JSONB array) across ALL raw_pulls rows for
  │  this source, then dedups — see "Article identity & dedup" below
  ▼
news_articles (Gold mart): article_id, headline, summary, byline,
  published_at, article_url, ingested_at
  │
  ├─► new FastAPI router api/src/api/routers/news.py
  │     GET /news?reporter=<optional byline substring>&limit=
  │     GET /tools/get-recent-news (typed tool endpoint, reporter optional)
  │
  ├─► web/app/news/page.tsx + web/app/api/news/route.ts (BFF proxy) —
  │     new page, with an optional reporter filter/tab
  │
  └─► new 5th tool get_recent_news in search-tools.ts's TOOL_DEFINITIONS,
        optional `reporter` param, same typed envelope/citation pattern as
        the other four tools
```

## Article identity & dedup

This is the one place "same pattern as every other staging model" needs a
real decision rather than a copy-paste. Every existing `stg_*` model dedups
via `row_number() over (partition by <id> order by pulled_at desc)`
because its source entity (a game, a box-score line) is the same row
re-pulled with updated values each poll. News is different in one
specific way:

- The same, unchanged article recurs across most 15-minute polls.
- Occasionally an article is edited in place by ESPN (a corrected
  headline or summary) — same `id`, new `lastModified`.
- Genuinely new articles enter the rolling window as older ones age out.

**Decision:** `stg_news_articles.sql`'s partition key MUST be ESPN's real
numeric `id` field (confirmed real and stable in Findings above) —
**never** a derived key such as a hash of `headline` + `published`. A
derived key breaks the moment a headline is corrected in place: the
"same" article would hash differently before and after the edit, and the
existing dedup pattern would silently treat it as two distinct articles
instead of one updated one. Using the real `id` means the standard
"latest `pulled_at` wins" pattern actually holds here exactly as it does
everywhere else — the risk was never the pattern itself, only which field
gets fed into it.

## Content reproduction & attribution

A deliberate decision, not an implicit side effect of a field name:

- **Chosen approach:** display ESPN's own `description` field (the short
  dek/summary — confirmed above to never contain the full article body)
  verbatim, always paired with byline attribution (e.g. "by Marc J.
  Spears, ESPN") and a prominent "Read the full story on ESPN" link-out
  using the real `links.web.href` URL. This is explicitly framed as
  **aggregation** — a short excerpt, attribution, and a link to the
  source — the same practice used by Apple News, Google News, and most
  sports-content aggregator sites, not a claim to original reporting.
- **Explicitly rejected: ESPN's article images.** The real payload does
  include `images[].url`/`credit`, but re-hosting or even hotlinking
  someone else's photography carries a distinct, less industry-normalized
  copyright risk than a short text excerpt. The news page and search
  answers show headline + summary + byline + link-out only — no image.
- This is a product/risk-tolerance call made explicitly here so it can be
  revisited deliberately during spec review, rather than discovered later
  as an unstated assumption.

## Reporter/byline filter

Possible now specifically because `byline` was verified populated at the
individual-reporter level (Findings above), not because Phase 2's
Instagram problem was solved:

- `byline` becomes a real, filterable column on `news_articles`.
- `/news` page gets an optional reporter filter/tab (e.g. "All NBA News"
  vs. a specific reporter) — left as an implementation detail, not
  further prescribed here.
- `get_recent_news` gets an optional `reporter` parameter (substring match
  against `byline`), so "what has Shams reported recently" can be
  answered honestly from real Gold data — if no bylined article matches,
  the tool returns `no_match`, the same CAP-5 discipline as the other four
  tools use for a genuine zero-result case. Never guessed, never
  approximated.

**Named limitation:** this only surfaces news ESPN itself has published
under a reporter's byline. It does not catch a scoop broken first on that
reporter's own Instagram/X — which is often minutes to hours ahead of an
ESPN-bylined write-up, and is the actual behavior the original "Shams post
bot" ask described. Closing that gap is exactly what a real Phase 2
(monitoring his own social channels directly) would do.

## Freshness: 15-minute polling vs. "breaking news" framing

Explicitly accepted: a headline arriving up to ~15 minutes late is a fine
trade-off for this feature. News does not need the live game board's 30s
freshness SLA (PRD §9) — a slower cadence also reduces load on an
unauthenticated public endpoint with no documented rate limit. This is a
deliberate difference in freshness bar between two features that will sit
on the same homepage.

## Search tool-routing: avoiding `get_recent_news` ambiguity

The existing four tools answer specific, structured stat questions
(`get_player_stats`, `get_team_games`, `get_leaders`, `get_game_result`).
`get_recent_news` is fuzzier — "what's going on with the Lakers" could
mean recent news, recent games, or both. Mitigation: extend
`search-loop.ts`'s existing `SYSTEM_PROMPT` (which already carries
explicit, non-negotiable tool-use rules, e.g. "Always call a tool before
answering a stats question") with one more rule in the same style: *"Use
`get_recent_news` only for questions about recent events, context,
injuries, trades, roster moves, or reporting — never for a question
asking for a specific stat, score, or ranking; use the matching stats tool
for those."* This stays consistent with the project's existing
prompt-based tool discipline rather than introducing a separate routing
mechanism (a classifier, a keyword router) the architecture doesn't
otherwise use.

## ToS / bot-detection note

**Correction from an earlier design pass:** the news endpoint is not
currently blocked from this (cloud) environment — verified directly by a
real request, 2026-09-07 (Findings above). This is a different situation
from `stats.nba.com`'s Akamai-based cloud-IP blocking, documented in
`docs/PROGRESS.md`'s `nba_api` section. It is still an undocumented,
unauthenticated public endpoint with no published terms covering this
kind of automated use — the same category of risk `PublicFeedClient`'s
existing ESPN scoreboard integration already carries in production via
`live_game_flow`, not a new one. Once this ships, add a short addendum to
`docs/PROGRESS.md`'s existing ESPN/`PublicFeedClient` note (rather than a
new entry) so both ESPN dependencies — scoreboard and news — are
documented together, matching how the `nba_api` ToS trade-off was named
explicitly rather than left as an implicit footnote.

## Testing

Following this repo's offline-verification convention (CLAUDE.md Testing
section):

- `news_flow.py` takes its `RawPullSink` (and any other Prefect-visible
  dependency) as a `@runtime_checkable` Protocol, the same mandatory
  pattern every existing flow uses (CLAUDE.md's Testing section — Prefect
  builds its parameter schema from type hints at decoration time, so a
  concrete-class annotation would reject duck-typed test fakes). Tested
  against a mocked HTTP response fixture (the real shape captured in
  Findings above), never a real network call.
- `stg_news_articles.sql`'s dedup logic is exercised with a fixture that
  includes the exact edge case named above — the same `id` recurring
  across multiple `raw_pulls` rows with a changed `headline`/`lastModified`
  on a later poll — asserting the mart keeps exactly one row (the latest)
  per `id`, never two.
- `get_recent_news` and `route.ts`'s wiring are unit-tested the same way
  as the other four tools: dependency-injected tool dispatch, no real
  FastAPI or LLM call.

## Review punch list (pre-implementation)

A structured review (adversarial + edge-case lenses, 12 findings each — 24
total) surfaced 21 distinct gaps below once overlapping findings are
merged into single items (marked "found independently by both lenses"
where that overlap is a stronger signal than either lens alone). None of
these change the chosen architecture; they're decisions and guards the
implementation plan needs to make explicit rather than leave implicit.
Grouped by theme:

**Ingestion & dedup correctness**
- [ ] Two ESPN content types could share the same numeric `id` — partition
      dedup by `(id, type)`, or filter `articles[]` to the article type
      before dedup, not by `id` alone.
- [ ] **Unbounded growth** (found independently by both lenses, from two
      angles): `news_articles` never expires stale entries, and
      `stg_news_articles.sql` unnests **all** `raw_pulls` rows for this
      source with no time bound — both the mart's staleness and the dbt
      scan cost grow unbounded over the pipeline's lifetime. Bound the
      window (e.g. only recent `raw_pulls` rows feed the mart, plus a
      `published_at`-based retention filter).
- [ ] A duplicate `(id, pulled_at)` pair within one poll has no deterministic
      tiebreaker — add a secondary sort key to `row_number()`.
- [ ] **News-burst window overflow** (found independently by both lenses):
      if ESPN publishes more new articles than the observed ~6-article
      rolling window within one 15-minute poll (trade deadline, draft
      night — exactly when the feature matters most), older articles are
      evicted and never captured by any poll. This is real, silent data
      loss, not covered by the "no backfill needed" non-goal. Either
      shorten the polling interval during known high-volume windows or
      detect/alert on window-churn exceeding poll frequency.
      Add a test fixture simulating this.

**API & tool contract completeness**
- [ ] `GET /news?limit=` has no defined behavior for missing/zero/negative/
      excessive values — define a default (e.g. 20) and a clamped max
      (e.g. 100).
- [ ] `get_recent_news` has no `limit`/bound parameter at all — add one,
      since an unbounded mart plus an unbounded tool call risks an
      ever-growing result set landing in the LLM's context.
- [ ] No defined zero-match behavior for `GET /news` or the `/news` page's
      reporter filter — only the LLM tool's `no_match` path is specified.
      Define an explicit empty-state (e.g. `200` with `[]`, and a stated
      empty UI) for parity.
- [ ] A missing/null `links.web.href` isn't guarded against, but the
      link-out is a stated Goal — filter out or flag articles lacking it
      before surfacing them.
- [ ] `news_articles`/`raw_pulls` has no `source` discriminator column.
      Phase 1 hardcodes `source="espn"`, so nothing reserves room for
      Phase 2 (Instagram) to arrive as an additive `UNION` rather than a
      breaking migration of the mart, the API contract, the search tool's
      envelope, and the page — the exact churn the "prove the simpler
      thing first" sequencing was meant to avoid.
- [ ] No error/backoff behavior is specified for a non-200/timeout response
      from ESPN — define retry-with-backoff vs. skip-and-log vs. raise,
      the same explicit treatment this project already gave a malformed
      NBA.com response (the "skip games with only one team's row instead
      of crashing" fix).

**Reporter/byline filter correctness**
- [ ] The substring match's case-sensitivity, generic-byline handling
      (`"ESPN"`/`"NBA Insiders"` matching too broadly), multi-author
      bylines, and outlet-suffix format drift (`"Shams Charania"` vs.
      `"Shams Charania, ESPN"`) are all unspecified — define the match
      semantics precisely (case-insensitive substring, or normalized-name
      match with substring fallback) rather than leaving "substring match
      against byline" as the whole spec.
- [ ] A null/empty `byline` plus a reporter filter has undefined SQL
      null-comparison behavior — `coalesce(byline, '')` or equivalent.
      Add a test fixture for a null-byline article flowing through both
      the mart and the filter.
- [ ] No real Shams-bylined article was observed in the sample pull —
      "his bylined articles plausibly appear" is inference, not a
      confirmed finding. Re-verify with a real example before relying on
      it, or state plainly that it's unconfirmed.
- [ ] The named Instagram-gap limitation misses the likelier failure mode:
      a story reported "per Shams" but written up under a *different*
      ESPN staffer's byline won't surface under `reporter="Shams"` — byline
      is authorship, not sourcing-attribution. Extend the named limitation
      to say so explicitly.

**Search tool-routing**
- [ ] A genuinely compound query ("is Embiid playing tonight and what's he
      averaging") isn't handled — the new mutually-exclusive routing rule
      picks one tool and silently drops the other half of the answer. Add
      a rule for compound questions to call both tools and combine.
- [ ] The new routing rule is only unit-tested at the DI'd-dispatch level,
      never verified against whether the LLM actually follows it on real
      ambiguous phrasing — add a small eval set of ambiguous queries
      asserting which tool gets selected.

**Content-risk claims needing evidence**
- [ ] "No re-publishing/copyright exposure" overstates a legal conclusion —
      the Apple News/Google News precedent involves licensing deals and
      legal infrastructure this project doesn't have, and ESPN's actual
      terms of use were never reviewed (only HTTP reachability was).
      Reframe as an accepted risk with no license obtained, not a settled
      fact.
- [ ] The "short excerpt" characterization of `description` was never
      quantified — record the actual observed character/word-count range
      from the sample pull in the Findings section, the same empirical
      rigor already applied to `id` and `byline`.

**Operational monitoring**
- [ ] ESPN's reachability is stated as an architectural fact ("GET, no
      auth") based on one successful check, with no monitoring/alerting
      specified for when that stops being true — add a health-check/alert
      on non-200 or a schema-shape mismatch.
- [ ] That reachability check ran in the design/dev environment, not
      confirmed to be the same network class as wherever `news_flow.py`
      will actually run in production — the exact axis `stats.nba.com`
      failed on. Re-verify from the real ingestion deployment environment
      before relying on it.
