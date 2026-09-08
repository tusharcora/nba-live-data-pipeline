# NBA News Feed (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the ESPN-sourced general NBA news feed (with a reporter/byline filter) end-to-end — ingestion → Gold mart → API → a new `/news` page — per the committed design spec, folding in every item from that spec's review punch list.

**Architecture:** Extends the existing medallion pipeline exactly the way every other source does: `PublicFeedClient` (already used for ESPN's scoreboard) grows a `get_news()` method feeding a new Prefect flow that writes Bronze `raw_pulls` rows; a new dbt staging model dedups on ESPN's real article `id` into a new Gold `news_articles` mart; a new FastAPI router serves both a browsing endpoint (`GET /news`) and a CAP-5-style lookup endpoint (`GET /news/lookup`) for the future NL-search tool, reusing the existing fail-open `cached_json` Redis helper; a new `/news` page and BFF route consume the browsing endpoint. The NL-search tool wiring (`get_recent_news` in `search-tools.ts`/`search-loop.ts`) is written in full but gated behind a branch-existence guard, since those files exist only on an unmerged feature branch as of this plan's writing.

**Tech Stack:** Python 3.12 / Prefect 3 / SQLAlchemy 2 / httpx (`ingestion`), dbt-core + Postgres (`dbt`), FastAPI + SQLAlchemy Core + Redis (`api`), Next.js 16 App Router + TypeScript (`web`).

**Spec:** `docs/superpowers/specs/2026-09-07-nba-news-feed-design.md` — this plan implements it in full, including its "Review punch list (pre-implementation)" section. Every checklist item there is folded into a task below (see each task's "Punch-list items resolved here").

## Global Constraints

**Deviations from the spec, found during real code inspection — follow existing code precedent over the spec's advance guess, per this repo's own established convention:**

- Bronze `raw_pulls.source` is `"public_feed"`, not `"espn"`. Verified against real code: `live_game_flow.py`'s `extract_public_feed_live_states` and its own test (`test_live_game_flow.py`: `assert sources == {"balldontlie", "public_feed"}`) both confirm every existing ESPN-origin Bronze row uses `source="public_feed"` (the client's name), not the underlying provider's name. This plan uses `source="public_feed", endpoint="news"`.
- No `/tools`-prefixed router exists on this branch. `query_tools.py` (home of the other four NL-search tools' FastAPI endpoints) lives only on the unmerged search-feature branch (`origin/worktree-search-result-tables`). The lookup endpoint this plan adds lives at `GET /news/lookup` instead of a `/tools/...` path — Task 5 points `TOOL_PATHS.get_recent_news` there if/when it runs.
- `PublicFeedClient` grows a `get_news()` method rather than becoming a new client class. Its existing `base_url` (`Settings().public_feed_base_url`, already `https://site.api.espn.com/apis/site/v2/sports/basketball/nba`) already matches the news endpoint's host — only the path differs, exactly like `get_scoreboard()`. No new `Settings` field needed.
- **This branch's `web/` package has no test runner at all** (checked: `web/package.json` has no `vitest`/`jest` dependency, no test script — only `dev`/`build`/`start`/`lint`; `.test.ts`/`.test.tsx` files only exist on the unmerged search-feature branch, which added its own Vitest setup). Task 4 (web) is therefore verified via `npx tsc --noEmit` + `npm run lint` + a manual dev-server check, matching this branch's actual current state — not via fabricated unit tests that would have no runner to execute them. Introducing a web test runner is out of scope for this plan.

**Non-negotiable project conventions (apply to every task):**

- Every Prefect flow parameter is a `@runtime_checkable` `Protocol` (CLAUDE.md's Testing section) — Prefect builds a Pydantic schema from type hints at decoration time; a bare `Protocol` crashes at import, a concrete-class annotation rejects duck-typed test fakes.
- No real HTTP, DB, or LLM call in any Python test — mock `httpx`, inject fakes via the DI seam.
- dbt models are verified via `dbt parse --no-partial-parse` / `dbt compile --no-populate-cache` in this environment (no live DB). Dedup correctness is enforced via `not_null`/`unique` `data_tests` on the mart's natural key (same as `games.yml`'s `game_id`) — this project's dbt models have no unit-test/seed-fixture mechanism today (checked: no `dbt/tests/` or `dbt/seeds/` directory exists), so this plan does not invent one; real dedup correctness is verified only when `dbt test` eventually runs against live data, same posture as every other staging model here.
- API caching reuses `api/core/cache.py`'s existing `cached_json()` fail-open Redis helper verbatim (already used by `games.py`/`quality.py`) — no new caching mechanism.
- Every new Python module ships with tests in the same commit; every dbt model ships with its `schema.yml` in the same commit.

---

## Task 1: ESPN news client + ingestion flow

**Files:**
- Modify: `ingestion/src/ingestion/sources/public_feed.py`
- Create: `ingestion/src/ingestion/flows/news_flow.py`
- Test: `ingestion/tests/test_public_feed.py` (extend)
- Test: `ingestion/tests/test_news_flow.py` (new)

**Interfaces:**
- Consumes: `RawPullSink` protocol + `RawPull` model + `Settings` (all already exist — `ingestion.flows.backfill_flow.RawPullSink`, `db.models.RawPull`, `ingestion.config.Settings`).
- Produces: `PublicFeedClient.get_news(self) -> dict`; `news_flow(raw_pull_sink: RawPullSink | None = None, public_feed_client: NewsSource | None = None) -> dict` returning `{"raw_pulls_written": int}`. No other task in this plan imports from this file (it's a leaf ingestion flow, wired into Prefect scheduling as a separate, later operational step — same posture as `live_game_flow`'s own scheduling, which is explicitly out of the flow body's scope).

**Punch-list items resolved here:** error/backoff behavior for non-2xx/timeout (documented decision below, not new machinery).

**Punch-list items explicitly accepted as out of this task's reach, not silently dropped:**
- *News-burst window overflow* (an article published and evicted from ESPN's own rolling window between two polls, never captured by any poll) cannot be fixed in the flow body — the flow only ever sees what ESPN's window currently returns. The only real mitigation is polling more frequently during known high-volume windows (trade deadline, draft night), which is a Prefect deployment-scheduling decision, not flow code, matching this project's existing posture that scheduling cadence lives outside the flow body (see `live_game_flow`'s own docstring). Noted here so it isn't rediscovered as a surprise later.
- *Reachability/schema-drift monitoring*: this project has no alerting infrastructure anywhere today (checked: no Slack/email/webhook integration exists in `ingestion`, `api`, or elsewhere) — building one is out of scope for a single feature's plan. `news_flow`'s existing raise-on-failure behavior (Step 3 below) already surfaces a real outage as a failed Prefect flow run, the same (if minimal) "monitoring" every other flow in this project relies on. Before this flow is ever scheduled for real, re-run `uv run python -c "from ingestion.sources.public_feed import PublicFeedClient; from ingestion.config import Settings; print(PublicFeedClient(base_url=Settings().public_feed_base_url).get_news())"` from wherever it will actually be deployed (not just this dev environment) — this project's own precedent (`stats.nba.com`'s cloud-IP block) is exactly why a dev-environment check alone isn't sufficient proof.

- [ ] **Step 1: Write the failing test for `get_news()`**

Add to `ingestion/tests/test_public_feed.py`, mirroring `test_get_scoreboard_returns_full_decoded_payload` exactly:

```python
def test_get_news_returns_full_decoded_payload():
    payload = {
        "header": "NBA News",
        "articles": [
            {
                "id": 49824980,
                "type": "Story",
                "headline": "Ben Simmons returning to NBA on 1-year deal",
                "description": "Ben Simmons is returning to the NBA.",
                "byline": "Marc J. Spears",
                "published": "2026-09-06T18:30:00Z",
                "lastModified": "2026-09-06T18:30:00Z",
                "links": {"web": {"href": "https://www.espn.com/nba/story/_/id/49824980/x"}},
            }
        ],
    }

    with patch("httpx.get", return_value=_response(payload)) as mock_get:
        client = PublicFeedClient(
            base_url="https://site.api.espn.com/apis/site/v2/sports/basketball/nba"
        )
        result = client.get_news()

    assert result == payload
    assert mock_get.call_count == 1

    call = mock_get.call_args
    assert (
        call.args[0]
        == "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news"
    )
    assert call.kwargs["params"] == {}
    assert "headers" not in call.kwargs or not call.kwargs["headers"]


def test_get_news_raises_on_non_2xx_response():
    response = Mock()
    response.raise_for_status.side_effect = httpx.HTTPStatusError(
        "boom", request=Mock(), response=Mock(status_code=500)
    )

    with patch("httpx.get", return_value=response):
        client = PublicFeedClient(
            base_url="https://site.api.espn.com/apis/site/v2/sports/basketball/nba"
        )
        with pytest.raises(httpx.HTTPStatusError):
            client.get_news()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ingestion && uv run pytest tests/test_public_feed.py -v`
Expected: FAIL with `AttributeError: 'PublicFeedClient' object has no attribute 'get_news'`

- [ ] **Step 3: Implement `get_news()`**

Add to `ingestion/src/ingestion/sources/public_feed.py`, immediately after `get_scoreboard`:

```python
    def get_news(self) -> dict:
        """Fetch the current rolling window of NBA news articles.

        Real payload shape, verified directly against a live response
        2026-09-07 (docs/superpowers/specs/2026-09-07-nba-news-feed-design.md's
        Findings section) — unlike `get_scoreboard`'s assumed shape, this one
        is confirmed, not guessed:

        GET https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news

        {
          "header": "NBA News",
          "articles": [
            {
              "id": 49824980,
              "type": "Story",
              "headline": "...",
              "description": "...",
              "byline": "Marc J. Spears",
              "published": "2026-09-06T18:30:00Z",
              "lastModified": "2026-09-06T18:30:00Z",
              "links": {"web": {"href": "https://www.espn.com/nba/story/..."}}
            }
          ]
        }

        A rolling window of the most recent articles (~6 observed in one
        real pull), not a paginated archive — no `dates`/pagination params,
        unlike `get_scoreboard`.

        No retry/backoff on a non-2xx response or timeout: `_get()` raises
        via `raise_for_status()`, same as every other HTTP client in this
        codebase (`BallDontLieClient`, `get_scoreboard` itself) — a failed
        flow run is Prefect's own concern, not something wrapped here. This
        is a deliberate consistency choice, not a gap.
        """
        return self._get("/news", {})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ingestion && uv run pytest tests/test_public_feed.py -v`
Expected: PASS (4 tests: 2 existing scoreboard tests + 2 new news tests)

- [ ] **Step 5: Commit**

```bash
git add ingestion/src/ingestion/sources/public_feed.py ingestion/tests/test_public_feed.py
git commit -m "feat(ingestion): add PublicFeedClient.get_news()"
```

- [ ] **Step 6: Write the failing flow-level tests**

Create `ingestion/tests/test_news_flow.py`, mirroring `test_live_game_flow.py`'s fake-DI style:

```python
from db.models import RawPull
from ingestion.flows.news_flow import news_flow


class FakeRawPullSink:
    def __init__(self) -> None:
        self.written: list[RawPull] = []

    def write(self, raw_pull: RawPull) -> None:
        self.written.append(raw_pull)


class FakeNewsSource:
    def __init__(self, payload: dict) -> None:
        self._payload = payload
        self.call_count = 0

    def get_news(self) -> dict:
        self.call_count += 1
        return self._payload


def _news_payload() -> dict:
    return {
        "header": "NBA News",
        "articles": [
            {
                "id": 49824980,
                "type": "Story",
                "headline": "Ben Simmons returning to NBA",
                "description": "...",
                "byline": "Marc J. Spears",
                "published": "2026-09-06T18:30:00Z",
                "links": {"web": {"href": "https://www.espn.com/x"}},
            }
        ],
    }


def test_news_flow_writes_one_raw_pull_for_the_whole_batch():
    sink = FakeRawPullSink()
    source = FakeNewsSource(_news_payload())

    result = news_flow(raw_pull_sink=sink, public_feed_client=source)

    assert len(sink.written) == 1
    pull = sink.written[0]
    assert pull.source == "public_feed"
    assert pull.endpoint == "news"
    assert pull.payload == _news_payload()
    assert result == {"raw_pulls_written": 1}


def test_news_flow_calls_the_source_exactly_once():
    sink = FakeRawPullSink()
    source = FakeNewsSource(_news_payload())

    news_flow(raw_pull_sink=sink, public_feed_client=source)

    assert source.call_count == 1
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `cd ingestion && uv run pytest tests/test_news_flow.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'ingestion.flows.news_flow'`

- [ ] **Step 8: Implement the flow**

Create `ingestion/src/ingestion/flows/news_flow.py`:

```python
from typing import Protocol, runtime_checkable

from prefect import flow, get_run_logger
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from db.models import RawPull
from ingestion.config import Settings
from ingestion.flows.backfill_flow import RawPullSink, SQLAlchemyRawPullSink
from ingestion.sources.public_feed import PublicFeedClient


@runtime_checkable
class NewsSource(Protocol):
    """Injectable news-feed client — matches `PublicFeedClient.get_news() -> dict`."""

    def get_news(self) -> dict: ...


@flow(name="news-flow")
def news_flow(
    raw_pull_sink: RawPullSink | None = None,
    public_feed_client: NewsSource | None = None,
) -> dict:
    """One poll cycle against ESPN's public news feed
    (docs/superpowers/specs/2026-09-07-nba-news-feed-design.md).

    A single pass, not a real-time loop — repeated polling is a Prefect
    deployment-scheduling concern (a ~15-minute cadence per the spec's
    "Freshness" section), out of scope for the flow body itself, same
    posture as `live_game_flow`.

    Writes exactly ONE Bronze `raw_pull` row per call, holding the whole
    `{"articles": [...]}` batch verbatim — matching `live_game_flow`'s own
    "one row, whole batch" shape for `public_feed`'s scoreboard endpoint,
    not a new one-row-per-article convention. `stg_news_articles.sql`
    unnests the array downstream.

    `raw_pull_sink`/`public_feed_client` are injected so the flow body
    never opens a DB connection or makes an HTTP call itself — see
    `ingestion/tests/test_news_flow.py` for the fakes used in tests.
    """
    logger = get_run_logger()

    session_factory: sessionmaker[Session] | None = None
    if raw_pull_sink is None:
        session_factory = sessionmaker(bind=create_engine(Settings().runtime_database_url))
    raw_pull_sink = raw_pull_sink or SQLAlchemyRawPullSink(session_factory)  # type: ignore[arg-type]
    public_feed_client = public_feed_client or PublicFeedClient(
        base_url=Settings().public_feed_base_url
    )

    news = public_feed_client.get_news()
    raw_pull_sink.write(RawPull(source="public_feed", endpoint="news", payload=news))

    logger.info("news_flow: wrote 1 raw_pull (%d articles in batch)", len(news.get("articles", [])))

    return {"raw_pulls_written": 1}
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `cd ingestion && uv run pytest tests/test_news_flow.py -v`
Expected: PASS (2 tests)

- [ ] **Step 10: Run the full ingestion suite to check for regressions**

Run: `cd ingestion && uv run pytest -v`
Expected: all tests PASS (no regressions in `test_public_feed.py`, `test_live_game_flow.py`, etc.)

- [ ] **Step 11: Commit**

```bash
git add ingestion/src/ingestion/flows/news_flow.py ingestion/tests/test_news_flow.py
git commit -m "feat(ingestion): add news_flow for ESPN's public news feed"
```

---

## Task 2: dbt staging model + Gold mart

**Files:**
- Create: `dbt/models/staging/stg_news_articles.sql`
- Create: `dbt/models/staging/stg_news_articles.yml`
- Create: `dbt/models/marts/news_articles.sql`
- Create: `dbt/models/marts/news_articles.yml`

**Interfaces:**
- Consumes: `{{ source('raw', 'raw_pulls') }}` (already defined in `dbt/models/staging/_sources.yml`), the exact `raw_pulls.payload` shape Task 1 writes (`{"articles": [{"id", "type", "headline", "description", "byline", "published", "links": {"web": {"href": ...}}}]}`).
- Produces: Gold `news_articles` table — columns `article_id` (bigint, PK), `headline` (text), `summary` (text, nullable), `byline` (text, nullable), `published_at` (timestamptz), `article_url` (text), `source` (text, hardcoded `'public_feed'` in Phase 1), `ingested_at` (timestamptz). Task 3 (API) reflects this table by name via SQLAlchemy Core, same as `games.py` reflects `games`.

**Punch-list items resolved here:** id/type collision, unbounded `raw_pulls` scan / mart growth, duplicate `(id, pulled_at)` tiebreaker, missing `article_url` guard, dedup-correctness enforcement (via `data_tests`, this project's real mechanism — no fixture harness exists here to write instead, see Global Constraints).

Since this project's dbt models have no live-DB-free unit-test mechanism (only structural `dbt parse`/`dbt compile`), "TDD" here means: write the model, verify it parses/compiles cleanly, and pin correctness via `data_tests` that would catch a real dedup bug when `dbt test` eventually runs against live data — the same verification story every other model in this project already has.

- [ ] **Step 1: Write the staging model**

Create `dbt/models/staging/stg_news_articles.sql`:

```sql
-- Silver staging model: parses/types one row per news article out of the
-- Bronze `raw_pulls` JSONB payloads for source='public_feed',
-- endpoint='news' (docs/superpowers/specs/2026-09-07-nba-news-feed-design.md),
-- and de-duplicates to the most-recently-pulled version of each article.
--
-- Real payload shape (verified directly against a live response,
-- 2026-09-07 -- see the design spec's Findings section, NOT an assumption
-- like most other staging models' header comments):
-- {
--   "header": "NBA News",
--   "articles": [
--     {
--       "id": 49824980,
--       "type": "Story",
--       "headline": "...",
--       "description": "...",
--       "byline": "Marc J. Spears",
--       "published": "2026-09-06T18:30:00Z",
--       "lastModified": "2026-09-06T18:30:00Z",
--       "links": {"web": {"href": "https://www.espn.com/nba/story/..."}}
--     }
--   ]
-- }
--
-- Dedup here differs from every other staging model's rationale (spec's
-- "Article identity & dedup" section): a game/box-score row is the same
-- entity re-pulled with updated values each poll, but a news article
-- mostly just RECURS unchanged across polls until it either gets
-- corrected in place (same `id`, new `lastModified`) or ages out of
-- ESPN's rolling window. The "keep latest pulled_at per id" pattern still
-- holds -- it just needs the real per-article `id`, not a derived key.

with raw_news_pulls as (

    select
        id as raw_pull_id,
        payload,
        pulled_at
    from {{ source('raw', 'raw_pulls') }}
    where source = 'public_feed'
      and endpoint = 'news'
      -- raw_pulls is append-only and grows forever; a rolling live feed
      -- only ever needs a recent window of pulls to reconstruct current
      -- state -- bounding this avoids an unbounded full-table scan on
      -- every dbt run (review punch list: "Unbounded growth").
      and pulled_at >= current_timestamp - interval '7 days'

),

-- One `raw_pulls` row holds a whole `{"articles": [...]}` batch -> explode
-- it so downstream CTEs operate one row per article.
exploded as (

    select
        article_json,
        raw_pull_id,
        pulled_at
    from raw_news_pulls
    cross join lateral jsonb_array_elements(payload -> 'articles') as article_json
    -- ESPN's feed can carry content types other than a written story
    -- (e.g. galleries, videos) whose `id` namespace isn't guaranteed
    -- disjoint from a Story's -- filtering to Story guards the dedup key
    -- below rather than trusting `id` alone across types (review punch
    -- list: "id/type collision").
    where article_json ->> 'type' = 'Story'

),

typed as (

    select
        (article_json ->> 'id')::bigint as article_id,
        article_json ->> 'headline' as headline,
        article_json ->> 'description' as summary,
        article_json ->> 'byline' as byline,
        (article_json ->> 'published')::timestamptz as published_at,
        article_json -> 'links' -> 'web' ->> 'href' as article_url,
        -- Hardcoded, not read off the payload -- this mart has exactly one
        -- source today. Reserving the column now means a real Phase 2
        -- source (Instagram) can arrive as an additive UNION ALL later,
        -- matching games.sql's own multi-source posture, rather than a
        -- breaking migration of this table plus its API/tool consumers
        -- (review punch list: "no source discriminator column").
        'public_feed' as source,
        raw_pull_id,
        pulled_at
    from exploded

),

deduped as (

    select
        *,
        row_number() over (
            partition by article_id
            -- `raw_pull_id` (the Bronze surrogate key, monotonically
            -- increasing) is the tiebreaker for two rows sharing the same
            -- `article_id` AND the same `pulled_at` -- e.g. two distinct
            -- `raw_pulls` rows written in the same instant (review punch
            -- list: "duplicate (id, pulled_at) pair"). The later-inserted
            -- row wins deterministically rather than depending on
            -- undefined row order.
            order by pulled_at desc, raw_pull_id desc
        ) as rn
    from typed

)

select
    article_id,
    headline,
    summary,
    byline,
    published_at,
    article_url,
    source,
    pulled_at as ingested_at
from deduped
where rn = 1
```

- [ ] **Step 2: Write the staging schema.yml**

Create `dbt/models/staging/stg_news_articles.yml`:

```yaml
version: 2

models:
  - name: stg_news_articles
    description: >
      Silver staging model. One row per NBA news article, parsed and typed
      out of the Bronze `raw_pulls.payload` JSONB for source='public_feed',
      endpoint='news' (docs/superpowers/specs/2026-09-07-nba-news-feed-design.md).
      `raw_pulls` is append-only, so the same article can recur across many
      polls -- this model de-duplicates to the single most-recently-pulled
      row per `article_id` via
      `row_number() over (partition by article_id order by pulled_at desc, raw_pull_id desc)`.

      Payload shape is confirmed against a real live response (2026-09-07),
      not an assumption -- see the design spec's Findings section.
    columns:
      - name: article_id
        description: ESPN's `id` for the article. Natural key of this model.
        data_tests:
          - not_null
          - unique
      - name: headline
        description: Article headline.
        data_tests:
          - not_null
      - name: summary
        description: >
          ESPN's own short dek/summary text (`description` field) -- never
          the full article body, which this endpoint does not return.
      - name: byline
        description: >
          Reporter attribution, e.g. "Marc J. Spears". Populated at the
          individual-reporter level on real data, but can be a generic
          value ("ESPN", "NBA Insiders") or absent -- no `not_null` test.
      - name: published_at
        description: Article publish timestamp (ESPN's `published` field).
        data_tests:
          - not_null
      - name: article_url
        description: Canonical ESPN article URL (`links.web.href`). Can be null if ESPN omits it.
      - name: source
        description: >
          Hardcoded `'public_feed'` today (this model's only source). A
          reserved discriminator column so a real Phase 2 source (e.g.
          Instagram) can arrive as an additive UNION ALL later rather than
          a breaking schema change -- see `news_articles.sql`'s header.
        data_tests:
          - not_null
      - name: ingested_at
        description: >
          `pulled_at` of the `raw_pulls` row this record was sourced from --
          specifically, the most recent pull for this `article_id`. Carried
          through for lineage/freshness, and is the ordering key used for
          de-duplication.
```

- [ ] **Step 3: Write the Gold mart**

Create `dbt/models/marts/news_articles.sql`:

```sql
-- Gold `news_articles` table (Phase 1 of
-- docs/superpowers/specs/2026-09-07-nba-news-feed-design.md): general NBA
-- news, ESPN-sourced. Straight passthrough of stg_news_articles' dedup,
-- same posture as stg_games.sql's own header comment ("mart layer is a
-- straight passthrough ... for now") -- only one source feeds this mart
-- today, so there is nothing to union or reconcile yet.
--
-- Filters out any article missing its link-out URL: the link-out is a
-- stated Goal in the design spec, so an article that can't satisfy it
-- isn't servable (review punch list: "missing links.web.href").
--
-- Carries `source` through (see stg_news_articles.sql) so a future Phase 2
-- source can UNION ALL onto this mart additively, same posture as
-- games.sql (review punch list: "no source discriminator column").

select
    article_id,
    headline,
    summary,
    byline,
    published_at,
    article_url,
    source,
    ingested_at
from {{ ref('stg_news_articles') }}
where article_url is not null
```

- [ ] **Step 4: Write the mart schema.yml**

Create `dbt/models/marts/news_articles.yml`:

```yaml
version: 2

models:
  - name: news_articles
    description: >
      Gold `news_articles` table (Phase 1 of
      docs/superpowers/specs/2026-09-07-nba-news-feed-design.md). One row
      per NBA news article. Straight passthrough of `stg_news_articles`,
      filtered to articles with a real link-out URL.
    config:
      # `api/src/api/routers/news.py`'s default listing orders by
      # `published_at desc` (same hot-query-index posture as
      # `games.yml`'s `game_date` index).
      indexes:
        - columns: ["published_at"]
          unique: false
    columns:
      - name: article_id
        description: ESPN's `id` for the article. Primary key of this table.
        data_tests:
          - not_null
          - unique
      - name: headline
        description: Article headline.
        data_tests:
          - not_null
      - name: summary
        description: ESPN's own short dek/summary text -- never the full article body.
      - name: byline
        description: Reporter attribution. See stg_news_articles.yml for the generic/absent-value caveat.
      - name: published_at
        description: Article publish timestamp.
        data_tests:
          - not_null
      - name: article_url
        description: Canonical ESPN article URL -- never null in this table (filtered in news_articles.sql).
        data_tests:
          - not_null
      - name: source
        description: >
          Hardcoded `'public_feed'` today. Reserved for a real Phase 2
          source to UNION ALL onto this mart additively -- see this
          model's header comment.
        data_tests:
          - not_null
      - name: ingested_at
        description: Lineage/freshness -- `pulled_at` of the source `raw_pulls` row.
```

- [ ] **Step 5: Verify the DAG parses**

Run: `cd dbt && uv run dbt parse --no-partial-parse`
Expected: succeeds with no errors (validates `{{ source(...) }}`/`{{ ref(...) }}` resolve and the DAG has no cycles).

- [ ] **Step 6: Verify the SQL compiles**

Run: `cd dbt && uv run dbt compile --no-populate-cache`
Expected: succeeds; inspect `target/compiled/nba_pipeline/models/staging/stg_news_articles.sql` and `target/compiled/nba_pipeline/models/marts/news_articles.sql` to confirm the rendered SQL matches what's written above (no live DB needed for this).

- [ ] **Step 7: Commit**

```bash
git add dbt/models/staging/stg_news_articles.sql dbt/models/staging/stg_news_articles.yml dbt/models/marts/news_articles.sql dbt/models/marts/news_articles.yml
git commit -m "feat(dbt): add stg_news_articles + news_articles Gold mart"
```

---

## Task 3: FastAPI router

**Files:**
- Create: `api/src/api/routers/news.py`
- Modify: `api/src/api/main.py`
- Test: `api/tests/test_news.py`

**Interfaces:**
- Consumes: `api.core.db.get_engine`, `api.core.cache.cached_json`, `api.core.rate_limit.limiter`/`DEFAULT_RATE_LIMIT`, `api.core.security.require_api_key` (all exist already, same imports as `games.py`). Reflects the Gold `news_articles` table Task 2 produces (columns: `article_id`, `headline`, `summary`, `byline`, `published_at`, `article_url`, `source`, `ingested_at` — `source` is reflected but not filtered/exposed by this router in Phase 1, since there is only one value; it exists for Phase 2 forward-compatibility).
- Produces: `GET /news?reporter=&limit=` → `{"data": [<article dict>, ...], "count": <int>}` (browsing, consumed by Task 4). `GET /news/lookup?reporter=&limit=` → `{"status": "ok", "data": [...], "message": None}` or `{"status": "no_match", "data": None, "message": <str>}` (consumed by Task 5, if/when it runs). `NewsReader` protocol with `list_news(reporter: str | None, limit: int) -> list[dict]`, overridden in tests via `get_news_reader`.

**Punch-list items resolved here:** `limit` bound (FastAPI `Query(..., ge=1, le=100)`), reporter-filter case-insensitivity + null-byline handling (`coalesce` + `ilike`), zero-match empty-state parity for the browsing endpoint (a plain empty list is already correct there) and explicit `no_match` for the lookup endpoint, `source` migration-safety (not directly applicable here — this is Task 2's concern — but this router's `NewsReader` seam means a future Phase 2 source union wouldn't touch this file's route signatures).

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_news.py`, mirroring `api/tests/test_games.py`'s fake-reader + fakeredis style:

```python
from datetime import datetime, timezone

import fakeredis
import pytest
from fastapi.testclient import TestClient

from api.core import cache as cache_module
from api.main import app
from api.routers.news import get_news_reader

API_KEY = "test-service-key"


class FakeNewsReader:
    """Test double for the news-reader DI seam (`NewsReader` protocol).

    Applies the same case-insensitive substring `reporter` filter (treating
    a null `byline` as an empty string) and `limit` truncation a real SQL
    query would, so filter tests exercise real route behavior.
    """

    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.received_reporter: str | None | str = "not-called"
        self.received_limit: int | str = "not-called"
        self.call_count = 0

    def list_news(self, reporter: str | None, limit: int) -> list[dict]:
        self.call_count += 1
        self.received_reporter = reporter
        self.received_limit = limit

        rows = self.rows
        if reporter:
            needle = reporter.lower()
            rows = [row for row in rows if needle in (row["byline"] or "").lower()]
        return rows[:limit]


FAKE_ROWS = [
    {
        "article_id": 1,
        "headline": "Ben Simmons returning to NBA",
        "summary": "...",
        "byline": "Marc J. Spears",
        "published_at": datetime(2026, 9, 6, 18, 30, tzinfo=timezone.utc),
        "article_url": "https://www.espn.com/nba/story/_/id/1",
        "ingested_at": datetime(2026, 9, 6, 18, 45, tzinfo=timezone.utc),
    },
    {
        "article_id": 2,
        "headline": "NBA trade rumors roundup",
        "summary": "...",
        "byline": None,
        "published_at": datetime(2026, 9, 6, 12, 0, tzinfo=timezone.utc),
        "article_url": "https://www.espn.com/nba/story/_/id/2",
        "ingested_at": datetime(2026, 9, 6, 12, 15, tzinfo=timezone.utc),
    },
]


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("API_SERVICE_KEY", API_KEY)
    fake = fakeredis.FakeRedis()
    monkeypatch.setattr(cache_module, "get_cache_client", lambda: fake)
    test_client = TestClient(app)
    yield test_client
    app.dependency_overrides.clear()


def test_list_news_returns_all_rows_with_no_filter(client):
    app.dependency_overrides[get_news_reader] = lambda: FakeNewsReader(FAKE_ROWS)

    response = client.get("/news", headers={"X-API-Key": API_KEY})

    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 2
    assert [row["article_id"] for row in body["data"]] == [1, 2]


def test_list_news_reporter_filter_is_case_insensitive(client):
    reader = FakeNewsReader(FAKE_ROWS)
    app.dependency_overrides[get_news_reader] = lambda: reader

    response = client.get("/news?reporter=spears", headers={"X-API-Key": API_KEY})

    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 1
    assert body["data"][0]["article_id"] == 1
    assert reader.received_reporter == "spears"


def test_list_news_reporter_filter_treats_null_byline_as_no_match(client):
    app.dependency_overrides[get_news_reader] = lambda: FakeNewsReader(FAKE_ROWS)

    response = client.get("/news?reporter=nobody", headers={"X-API-Key": API_KEY})

    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 0
    assert body["data"] == []


def test_list_news_limit_rejects_out_of_range_values(client):
    app.dependency_overrides[get_news_reader] = lambda: FakeNewsReader(FAKE_ROWS)

    too_low = client.get("/news?limit=0", headers={"X-API-Key": API_KEY})
    too_high = client.get("/news?limit=101", headers={"X-API-Key": API_KEY})

    assert too_low.status_code == 422
    assert too_high.status_code == 422


def test_list_news_default_limit_is_20(client):
    reader = FakeNewsReader(FAKE_ROWS)
    app.dependency_overrides[get_news_reader] = lambda: reader

    client.get("/news", headers={"X-API-Key": API_KEY})

    assert reader.received_limit == 20


def test_lookup_news_returns_ok_status_with_matches(client):
    app.dependency_overrides[get_news_reader] = lambda: FakeNewsReader(FAKE_ROWS)

    response = client.get("/news/lookup?reporter=Spears", headers={"X-API-Key": API_KEY})

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert len(body["data"]) == 1
    assert body["message"] is None


def test_lookup_news_returns_no_match_status_when_empty(client):
    app.dependency_overrides[get_news_reader] = lambda: FakeNewsReader(FAKE_ROWS)

    response = client.get("/news/lookup?reporter=Nobody", headers={"X-API-Key": API_KEY})

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "no_match"
    assert body["data"] is None
    assert body["message"]


def test_list_news_second_request_is_served_from_cache(client, monkeypatch):
    reader = FakeNewsReader(FAKE_ROWS)
    app.dependency_overrides[get_news_reader] = lambda: reader

    client.get("/news", headers={"X-API-Key": API_KEY})
    client.get("/news", headers={"X-API-Key": API_KEY})

    assert reader.call_count == 1


def test_list_news_falls_open_when_redis_is_unreachable(client, monkeypatch):
    class _BrokenClient:
        def get(self, *_args, **_kwargs):
            raise ConnectionError("boom")

        def set(self, *_args, **_kwargs):
            raise ConnectionError("boom")

    monkeypatch.setattr(cache_module, "get_cache_client", lambda: _BrokenClient())
    app.dependency_overrides[get_news_reader] = lambda: FakeNewsReader(FAKE_ROWS)

    response = client.get("/news", headers={"X-API-Key": API_KEY})

    assert response.status_code == 200
    assert response.json()["count"] == 2
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_news.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'api.routers.news'`

- [ ] **Step 3: Implement the router**

Create `api/src/api/routers/news.py`:

```python
"""`GET /news` and `GET /news/lookup` -- the Phase 1 NBA news feed
(docs/superpowers/specs/2026-09-07-nba-news-feed-design.md), reading the
dbt-owned Gold `news_articles` table.

Two endpoints for two different real consumers, same posture as
`query_tools.py`'s explicit split from `games.py`'s browsing convention:

- `GET /news` -- the `/news` page's browsing endpoint (Task 4). A filter
  that matches nothing is a perfectly valid empty list; no special-casing
  needed.
- `GET /news/lookup` -- the future NL-search tool's endpoint (Task 5, if
  it runs). Zero matches must be an explicit `"no_match"` status, never an
  empty-but-"ok" list, so the LLM loop can tell "found nothing" apart from
  "found an empty result" without guessing (this project's CAP-5
  discipline, same as the four existing search tools).

Table reflected via SQLAlchemy Core (`Table(..., autoload_with=engine)`),
same read-only-table-we-don't-own pattern as `games.py`.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import MetaData, Table, func, select
from sqlalchemy.engine import Engine

from api.core.cache import cached_json
from api.core.db import get_engine
from api.core.rate_limit import DEFAULT_RATE_LIMIT, limiter
from api.core.security import require_api_key

router = APIRouter(prefix="/news", tags=["news"], dependencies=[Depends(require_api_key)])

# News changes as slowly as `news_flow`'s ~15-minute poll cadence (design
# spec's "Freshness" section) -- a longer TTL than `/games`' 15s is fine
# and further reduces load on the underlying table.
CACHE_TTL_SECONDS = 60

DEFAULT_LIMIT = 20
MAX_LIMIT = 100

NO_MATCH_MESSAGE = "No recent news matched that request."


@runtime_checkable
class NewsReader(Protocol):
    """Injectable read path for the Gold `news_articles` table."""

    def list_news(self, reporter: str | None, limit: int) -> list[dict]: ...


class SQLAlchemyNewsReader:
    """Production `NewsReader`, backed by the dbt-owned Gold `news_articles` table."""

    def __init__(self, engine: Engine | None = None) -> None:
        self._engine = engine or get_engine()

    def list_news(self, reporter: str | None, limit: int) -> list[dict]:
        metadata = MetaData()
        news_articles = Table("news_articles", metadata, autoload_with=self._engine)

        stmt = select(news_articles).order_by(news_articles.c.published_at.desc()).limit(limit)
        if reporter:
            # coalesce(byline, '') so a NULL byline compares against ''
            # rather than producing NULL (and therefore excluding the row
            # from a NOT filter, or behaving unpredictably) -- and ilike
            # for a case-insensitive substring match (review punch list:
            # "case sensitivity" + "null byline" findings).
            stmt = stmt.where(func.coalesce(news_articles.c.byline, "").ilike(f"%{reporter}%"))

        with self._engine.connect() as conn:
            return [dict(row) for row in conn.execute(stmt).mappings().all()]


def get_news_reader() -> NewsReader:
    """FastAPI dependency factory -- overridden in tests via
    `app.dependency_overrides[get_news_reader]` to inject a fake reader.
    """
    return SQLAlchemyNewsReader()


@router.get("/")
@limiter.limit(DEFAULT_RATE_LIMIT)
def list_news(
    request: Request,
    reporter: str | None = Query(
        default=None,
        description="Filter to articles whose byline contains this substring "
        "(case-insensitive), e.g. ?reporter=Charania.",
    ),
    limit: int = Query(
        default=DEFAULT_LIMIT,
        ge=1,
        le=MAX_LIMIT,
        description=f"Max articles to return, {1}-{MAX_LIMIT} (default {DEFAULT_LIMIT}).",
    ),
    reader: NewsReader = Depends(get_news_reader),
) -> dict:
    """Recent NBA news, most recently published first.

    - No params -- the most recent `limit` (default 20) articles.
    - `?reporter=<substring>` -- only articles whose byline contains the
      given substring, case-insensitive (e.g. `?reporter=Charania`). A
      filter that matches nothing returns a valid empty list, not an error.
    - `?limit=<1-100>` -- caps the number of rows returned; out-of-range
      values are a 422 (FastAPI's own `Query` validation), not silently
      clamped.

    Response shape:
        {"data": [<article row as a dict>, ...], "count": <int>}
    """

    def _compute() -> dict:
        rows = reader.list_news(reporter, limit)
        return {"data": rows, "count": len(rows)}

    cache_key = f"news:{reporter or ''}:{limit}"
    return cached_json(cache_key, CACHE_TTL_SECONDS, _compute)


@router.get("/lookup")
@limiter.limit(DEFAULT_RATE_LIMIT)
def lookup_news(
    request: Request,
    reporter: str | None = Query(default=None, description="Same substring filter as GET /news."),
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    reader: NewsReader = Depends(get_news_reader),
) -> dict:
    """CAP-5-style lookup for the future NL-search tool (Task 5).

    Response shape:
        {"status": "ok", "data": [<article row>, ...], "message": None}
        {"status": "no_match", "data": None, "message": <str>}
    """

    def _compute() -> dict:
        rows = reader.list_news(reporter, limit)
        if not rows:
            return {"status": "no_match", "data": None, "message": NO_MATCH_MESSAGE}
        return {"status": "ok", "data": rows, "message": None}

    cache_key = f"news:lookup:{reporter or ''}:{limit}"
    return cached_json(cache_key, CACHE_TTL_SECONDS, _compute)
```

- [ ] **Step 4: Register the router**

Modify `api/src/api/main.py`:

```python
from api.routers import games, live, news, player_stats, quality
```

```python
app.include_router(games.router)
app.include_router(live.router)
app.include_router(quality.router)
app.include_router(player_stats.router)
app.include_router(news.router)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_news.py -v`
Expected: PASS (9 tests)

- [ ] **Step 6: Run the full API suite to check for regressions**

Run: `cd api && uv run pytest -v`
Expected: all tests PASS

- [ ] **Step 7: Commit**

```bash
git add api/src/api/routers/news.py api/src/api/main.py api/tests/test_news.py
git commit -m "feat(api): add GET /news and GET /news/lookup"
```

---

## Task 4: Web page, BFF route, and nav

**Files:**
- Create: `web/app/api/news/route.ts`
- Create: `web/app/news/page.tsx`
- Create: `web/app/components/sections/news-section.tsx`
- Modify: `web/app/components/jump-links.tsx`
- Modify: `web/app/components/command-palette.tsx`

**Interfaces:**
- Consumes: `GET /news?reporter=&limit=` (Task 3's exact response shape: `{"data": [{article_id, headline, summary, byline, published_at, article_url, ingested_at}], "count": number}`).
- Produces: `/news` page, reachable from `JumpLinks`/the command palette like every other page.

**Punch-list items resolved here:** zero-match empty-state UI parity (an explicit "no articles match" message, not a blank/ambiguous screen).

**Verification for this task is `npx tsc --noEmit` + `npm run lint` + a manual dev-server check** — this branch's `web/` package has no test runner installed (see Global Constraints); there is nothing to write a failing Vitest test against.

- [ ] **Step 1: Add the BFF route**

Create `web/app/api/news/route.ts`, mirroring `web/app/api/games/route.ts`'s fetch-through pattern:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { fetchFromApi } from "@/lib/fastapi-client";

export async function GET(request: NextRequest) {
  const reporter = request.nextUrl.searchParams.get("reporter");
  const limit = request.nextUrl.searchParams.get("limit");

  const params = new URLSearchParams();
  if (reporter) params.set("reporter", reporter);
  if (limit) params.set("limit", limit);
  const query = params.toString();

  try {
    const data = await fetchFromApi(`/news${query ? `?${query}` : ""}`);
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ status: "unreachable" }, { status: 502 });
  }
}
```

- [ ] **Step 2: Add the news section component**

Create `web/app/components/sections/news-section.tsx`:

```typescript
"use client";

import { useEffect, useState } from "react";
import { Newspaper } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { FOCUS_RING } from "@/lib/focus-ring";
import { cn } from "@/lib/utils";

// Response shape matches `GET /news` (`api/src/api/routers/news.py`) as
// forwarded verbatim by `app/api/news/route.ts`.
type NewsArticle = {
  article_id: number;
  headline: string;
  summary: string | null;
  byline: string | null;
  published_at: string;
  article_url: string;
};

type ApiList<T> = { data: T[]; count: number };

type FetchState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; articles: NewsArticle[] };

const FETCH_ERROR_MESSAGE = "Couldn't reach the news service. Please try again.";

/** "2026-09-06T18:30:00Z" -> "Sep 6, 2026" -- same locale-formatting
 * approach as `formatGameDate` elsewhere in this app. */
function formatPublishedDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function NewsSection() {
  const [reporter, setReporter] = useState("");
  const [state, setState] = useState<FetchState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    const params = new URLSearchParams();
    if (reporter.trim()) params.set("reporter", reporter.trim());
    const query = params.toString();

    fetch(`/api/news${query ? `?${query}` : ""}`)
      .then((res) => res.json())
      .then((data: ApiList<NewsArticle> | null) => {
        if (!cancelled) setState({ status: "loaded", articles: data?.data ?? [] });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });

    return () => {
      cancelled = true;
    };
  }, [reporter]);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-xl font-semibold">
          <Newspaper className="size-5" aria-hidden="true" />
          NBA News
        </h2>
        <Input
          value={reporter}
          onChange={(e) => setReporter(e.target.value)}
          placeholder="Filter by reporter (e.g. Charania)"
          className={cn("max-w-xs", FOCUS_RING)}
          aria-label="Filter news by reporter"
        />
      </div>

      {state.status === "loading" && (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      )}

      {state.status === "error" && (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load news</AlertTitle>
          <AlertDescription>{FETCH_ERROR_MESSAGE}</AlertDescription>
        </Alert>
      )}

      {state.status === "loaded" && state.articles.length === 0 && (
        <Alert>
          <AlertTitle>No articles found</AlertTitle>
          <AlertDescription>
            {reporter.trim()
              ? `No recent articles matched "${reporter.trim()}".`
              : "No recent NBA news available right now."}
          </AlertDescription>
        </Alert>
      )}

      {state.status === "loaded" &&
        state.articles.map((article) => (
          <Card key={article.article_id}>
            <CardHeader>
              <CardTitle className="text-base">
                <a
                  href={article.article_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn("hover:underline", FOCUS_RING)}
                >
                  {article.headline}
                </a>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
              {article.summary && <p>{article.summary}</p>}
              <div className="flex flex-wrap items-center gap-2">
                {article.byline && <Badge variant="outline">{article.byline}</Badge>}
                <span>{formatPublishedDate(article.published_at)}</span>
              </div>
            </CardContent>
          </Card>
        ))}
    </section>
  );
}

export default NewsSection;
```

- [ ] **Step 3: Add the page**

Create `web/app/news/page.tsx`, mirroring `web/app/explorer/page.tsx` exactly:

```typescript
import { SiteHeader } from "@/app/components/site-header";
import { NewsSection } from "@/app/components/sections/news-section";

export default function NewsPage() {
  return (
    <div className="flex flex-1 flex-col">
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
        <SiteHeader current="/news" />
        <NewsSection />
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Add `/news` to the page nav**

Modify `web/app/components/jump-links.tsx`:

```typescript
const LINKS = [
  { href: "/", label: "Home" },
  { href: "/live", label: "Live" },
  { href: "/quality", label: "Quality" },
  { href: "/explorer", label: "Explorer" },
  { href: "/news", label: "News" },
  { href: "/settings", label: "Settings" },
] as const;
```

- [ ] **Step 5: Add `/news` to the command palette**

Modify `web/app/components/command-palette.tsx`: add `Newspaper` to the `lucide-react` import list, and add a row to `NAV_ITEMS`:

```typescript
import {
  Activity,
  BarChart3,
  Gauge,
  Newspaper,
  Radio,
  Search,
  Settings as SettingsIcon,
} from "lucide-react";
```

```typescript
const NAV_ITEMS = [
  { href: "/", label: "Home", icon: Activity },
  { href: "/live", label: "Live Board", icon: Radio },
  { href: "/quality", label: "Data Quality Scorecard", icon: BarChart3 },
  { href: "/explorer", label: "Historical Explorer", icon: Search },
  { href: "/news", label: "NBA News", icon: Newspaper },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
] as const;
```

- [ ] **Step 6: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Lint**

Run: `cd web && npm run lint`
Expected: no errors.

- [ ] **Step 8: Manual verification in a real browser**

Per CLAUDE.md's UI-testing convention: start the dev server (`cd web && npm run dev`), navigate to `/news`, and confirm:
- The page loads with the header/ticker/jump-links intact and "News" highlighted as current.
- Articles render (or, if the FastAPI service isn't running locally, the error state renders — confirm it says "Couldn't reach the news service", not a blank page).
- Typing into the reporter filter re-fetches and either narrows the list or shows the "No recent articles matched..." empty state.
- The command palette (its usual keyboard shortcut) lists "NBA News" and navigates to `/news` on selection.

- [ ] **Step 9: Commit**

```bash
git add web/app/api/news/route.ts web/app/news/page.tsx web/app/components/sections/news-section.tsx web/app/components/jump-links.tsx web/app/components/command-palette.tsx
git commit -m "feat(web): add /news page, BFF route, and nav entries"
```

---

## Task 5: NL-search tool wiring — GATED, do not start blindly

**This task modifies files that do not exist on this branch.** `web/lib/search-tools.ts` and `web/lib/search-loop.ts` exist only on `origin/worktree-search-result-tables` (and sibling branches `story2/bff-search-route`, `story3/search-page-ui`) as of this plan's writing. **Do not create these files from scratch if they're missing — that would silently reimplement or fork a real, separately-developed feature.**

**Files:**
- Modify: `web/lib/search-tools.ts`
- Modify: `web/lib/search-loop.ts`

**Interfaces:**
- Consumes: `GET /news/lookup?reporter=&limit=` (Task 3's exact response shape).
- Produces: a 5th entry in `TOOL_DEFINITIONS`, `ToolName`, `TOOL_PATHS`, `TOOL_TABLE_MAP`, `buildQuery`, `hasRequiredFields`, `deriveDateRange`, `deriveResultData` (all in `search-tools.ts`), plus one new rule appended to `search-loop.ts`'s `SYSTEM_PROMPT`.

**Punch-list items resolved here:** compound-query routing (a rule for calling both tools), routing-rule verification (a scripted-dispatch test — see Step 8's honesty note), Instagram-gap named-limitation extension (documented in the tool's own description text, surfaced to the model).

**Note on the "unbounded tool result" punch-list item:** `get_recent_news`'s schema (Step 6 below) deliberately does **not** expose a `limit` parameter to the model. `GET /news/lookup` (Task 3) already defaults to 20 rows and caps at 100 server-side regardless of what's requested — bounding the result at the API layer, where it can't be bypassed by an LLM picking an unreasonable value, is a cleaner fix than trusting the model to set one.

- [ ] **Step 0: Guard — verify the target files exist on this branch**

Run: `git show HEAD:web/lib/search-tools.ts > /dev/null 2>&1 && echo EXISTS || echo MISSING`

If `MISSING`: **stop this task immediately.** Report back: "Task 5 is blocked — `web/lib/search-tools.ts` doesn't exist on this branch. The NL-search feature (branches `story2/bff-search-route`, `story3/search-page-ui`, `origin/worktree-search-result-tables`) needs to be merged first." Do not proceed to Step 1. Do not invent these files.

If `EXISTS`, proceed.

- [ ] **Step 1: Write the failing test for the new tool definition**

Add to `web/lib/search-tools.test.ts` (the existing test file on that branch), following its established style for the other four tools' `TOOL_DEFINITIONS`/`callTool` tests:

```typescript
describe("get_recent_news", () => {
  it("is present in TOOL_DEFINITIONS with an optional reporter param", () => {
    const def = TOOL_DEFINITIONS.find((t) => t.name === "get_recent_news");
    expect(def).toBeDefined();
    expect(def?.inputSchema.required ?? []).not.toContain("reporter");
  });

  it("dispatches to GET /news/lookup with the reporter param forwarded", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: "ok",
      data: [{ article_id: 1, headline: "x", byline: "Shams Charania", published_at: "2026-09-06" }],
      message: null,
    });
    vi.mocked(fetchFromApi).mockImplementation(fetchMock);

    const result = await callTool("get_recent_news", { reporter: "Shams" });

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/news/lookup"));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("reporter=Shams"));
    expect(result.status).toBe("ok");
    expect(result.table).toBe("news_articles");
  });

  it("returns no_match status as-is when the endpoint reports no_match", async () => {
    vi.mocked(fetchFromApi).mockResolvedValue({
      status: "no_match",
      data: null,
      message: "No recent news matched that request.",
    });

    const result = await callTool("get_recent_news", {});

    expect(result.status).toBe("no_match");
    expect(result.table).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run search-tools.test.ts`
Expected: FAIL — `get_recent_news` not found in `TOOL_DEFINITIONS`.

- [ ] **Step 3: Add the tool to the type union and dispatch tables**

Modify `web/lib/search-tools.ts`:

```typescript
type ToolName =
  | "get_player_stats"
  | "get_team_games"
  | "get_leaders"
  | "get_game_result"
  | "get_recent_news";

const TOOL_PATHS: Record<ToolName, string> = {
  get_player_stats: "/tools/player-stats",
  get_team_games: "/tools/team-games",
  get_leaders: "/tools/leaders",
  get_game_result: "/tools/game-result",
  get_recent_news: "/news/lookup",
};

const TOOL_TABLE_MAP: Record<ToolName, string> = {
  get_player_stats: "player_game_stats",
  get_team_games: "games",
  get_leaders: "player_game_stats",
  get_game_result: "games",
  get_recent_news: "news_articles",
};
```

- [ ] **Step 4: Add the query-building and required-field cases**

Modify `buildQuery`'s `switch` in `web/lib/search-tools.ts`:

```typescript
    case "get_recent_news": {
      if (typeof input.reporter === "string" && input.reporter) {
        params.set("reporter", input.reporter);
      }
      break;
    }
```

Modify `hasRequiredFields`'s `switch`:

```typescript
    case "get_recent_news":
      return true;
```

- [ ] **Step 5: Add the date-range and result-data derivation cases**

Modify `deriveDateRange`'s function body in `web/lib/search-tools.ts` (news articles carry `published_at` per row, not a nested `games` array — add a dedicated branch before the final `games`-array fallback):

```typescript
  if (name === "get_recent_news") {
    const rows = payload.data;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const dates = rows
      .map((row) => (row && typeof row === "object" ? (row as { published_at?: unknown }).published_at : null))
      .filter((d): d is string => typeof d === "string")
      .sort();
    if (dates.length === 0) return null;
    return formatDateRange(dates[0], dates[dates.length - 1]);
  }
```

Modify `deriveResultData`'s `switch` in `web/lib/search-tools.ts` — Phase 1 deliberately returns `null` (design spec's non-goal: no new structured-table/resultData rendering for news, to avoid scope creep into the search-results-tables system):

```typescript
    case "get_recent_news":
      return null;
```

- [ ] **Step 6: Add the tool definition**

Modify `TOOL_DEFINITIONS` in `web/lib/search-tools.ts`, appending after `get_game_result`:

```typescript
  {
    name: "get_recent_news",
    description:
      "Look up recent NBA news headlines, optionally filtered to a specific reporter's byline (e.g. \"Shams Charania\"). Only surfaces news ESPN has published under that reporter's own byline -- it does NOT catch a scoop that reporter broke first on their own social media before an ESPN write-up existed, and it does NOT catch a story ESPN attributes to that reporter's information but bylines to a different staff writer. Returns status \"no_match\" if nothing matches.",
    inputSchema: {
      type: "object",
      properties: {
        reporter: {
          type: "string",
          description: "Optional reporter name substring to filter by byline, e.g. \"Charania\".",
        },
      },
      required: [],
    },
  },
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd web && npx vitest run search-tools.test.ts`
Expected: PASS.

- [ ] **Step 8: Add the tool-routing rule to the system prompt**

Modify `SYSTEM_PROMPT` in `web/lib/search-loop.ts`, appending two rules after the existing "Always call a tool before answering a stats question" rule:

```typescript
- Use get_recent_news only for questions about recent events, context, injuries, trades, roster moves, or reporting -- never for a question asking for a specific stat, score, or ranking; use the matching stats tool for those.
- If a question genuinely asks for both a stat AND recent news/context (e.g. "is Embiid playing tonight and what's he averaging"), call get_recent_news AND the relevant stats tool, then combine both answers -- do not silently pick only one.
```

**Honesty note on verifying this rule (punch list: "routing rule never tested against real ambiguous phrasing"):** this repo's testing convention forbids real LLM calls in any test (CLAUDE.md's Testing section), so no test here can prove the *actual* model follows this prompt rule on genuinely ambiguous real-world phrasing — that's an inherent limit of prompt-based behavior, not something a unit test can close. What Step 9 below tests is that `search-loop.ts`'s dispatch mechanics correctly call multiple tools and combine their results when the (fake, scripted) LLM client returns multiple tool calls in one turn — i.e., the plumbing works, not that the real model reliably chooses to use it. Real verification of the prompt rule's effectiveness is a manual/operational QA concern (try real ambiguous questions against the deployed feature and observe), same posture as this project's other prompt-engineering choices.

- [ ] **Step 9: Write the failing test for combined-tool dispatch**

Add to `web/lib/search-loop.test.ts`:

```typescript
it("calls both a stats tool and get_recent_news when the LLM requests both in one turn, and combines both results", async () => {
  const scriptedClient: LlmClient = {
    send: vi.fn()
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [
          { name: "get_player_stats", input: { player_name: "Embiid" } },
          { name: "get_recent_news", input: { reporter: "" } },
        ],
      })
      .mockResolvedValueOnce({ text: "Embiid is averaging 30 points and is questionable per recent reporting.", toolCalls: [] }),
  };
  const fakeCallTool: CallTool = vi.fn(async (name) =>
    name === "get_player_stats"
      ? { status: "ok", table: "player_game_stats", date_range: "2026-09-01", resultData: null, data: {}, candidates: null, message: null }
      : { status: "ok", table: "news_articles", date_range: "2026-09-06", resultData: null, data: {}, candidates: null, message: null }
  );

  const result = await runSearchLoop({
    question: "is Embiid playing tonight and what's he averaging",
    llmClient: scriptedClient,
    callTool: fakeCallTool,
  });

  expect(fakeCallTool).toHaveBeenCalledWith("get_player_stats", expect.anything());
  expect(fakeCallTool).toHaveBeenCalledWith("get_recent_news", expect.anything());
  expect(result.answerText).toContain("Embiid");
});
```

- [ ] **Step 10: Run test to verify it passes (or confirm existing multi-tool-call handling already covers it)**

Run: `cd web && npx vitest run search-loop.test.ts`

If it fails because `search-loop.ts`'s existing loop only records the *last* successful tool result (`lastToolResult`) rather than combining multiple: this is a real, separate gap in the base search-loop architecture (predating this plan), not something Task 5 should silently patch as a side effect. If it fails this way, stop and report back rather than reworking `finalize()`'s single-`lastToolResult` design under this task — that's a decision for whoever owns the base search feature's design, not an implicit scope expansion here.

- [ ] **Step 11: Type-check and lint**

Run: `cd web && npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add web/lib/search-tools.ts web/lib/search-tools.test.ts web/lib/search-loop.ts web/lib/search-loop.test.ts
git commit -m "feat(web): add get_recent_news search tool with reporter filter"
```

---

## Punch-list items intentionally left to the spec doc, not this plan

Three of the 21 review punch-list items are prose/documentation edits to
`docs/superpowers/specs/2026-09-07-nba-news-feed-design.md` itself, not
implementation work — this plan builds the system the spec describes, it
doesn't rewrite the spec's own text:

- Reframing "no re-publishing/copyright exposure" as an accepted risk
  rather than a settled legal conclusion.
- Recording the actual observed length range of ESPN's `description` field
  in the spec's Findings section.
- Confirming (or explicitly flagging as unconfirmed) a real Shams-bylined
  ESPN article, rather than the current "plausibly appear" phrasing.

Worth a follow-up edit to the spec file directly if/when convenient.

## Execution notes for parallel dispatch

Tasks 1-4 have no code dependency on each other's *implementation* — only on the exact shared contracts pinned in this plan (the `raw_pulls` source/endpoint values, the `news_articles` column names, the `GET /news` response shape). They can be dispatched to four subagents simultaneously. Task 5 must not be dispatched until Step 0's guard has been checked — either hold it back entirely for this round, or dispatch it last with explicit instructions to honor its Step 0 guard.
