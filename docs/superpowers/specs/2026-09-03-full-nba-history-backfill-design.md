# Full NBA History Backfill — Design

## Context

`player_game_stats` went from permanently empty to real data on 2026-09-03: the `nba_stats` source (a local-only `nba_api`/`stats.nba.com` backfill, see `docs/PROGRESS.md`) was run for real against a 3-day pilot window (2024-01-01–01-03), matching its games onto balldontlie's already-ingested Gold `games` table by team-name overlap.

The user then asked whether every NBA game ever played (not just a 3-day pilot) could realistically be backfilled. This spec covers that: extending the historical box-score backfill from a 3-day pilot to the full **1996-97 through 2025-26 seasons** (30 seasons — the modern, box-score-complete era; earlier eras lack tracked steals/blocks pre-1973-74 and threes pre-1979-80, and are out of scope here).

Getting there requires a real redesign, not just "run the existing flow with a wider date range" — three things discovered during design research make the existing pilot's approach unworkable at this scale:

1. **Game discovery was one API call per calendar day.** Fine for a 3-day pilot; at 30 seasons that's ~10,950 calls to discover mostly-empty days. Both balldontlie and nba_api support querying an entire season in one bulk call instead.
2. **balldontlie's free-tier API key is capped at 5 requests/minute** (confirmed empirically — see Findings below), far more restrictive than assumed. This mostly affects game *discovery* (not box scores, which come from nba_api and are unaffected), but combined with finding 3 below, it tips the balance toward not depending on balldontlie for the historical range at all.
3. **The existing team-name-overlap matcher (used to translate nba_api's games onto balldontlie's `game_id` space) breaks for renamed franchises.** Confirmed empirically: nba_api preserves period-accurate historical team names (`"Vancouver Grizzlies"`, `"New Jersey Nets"`, `"Seattle SuperSonics"`, `"Washington Bullets"`), while balldontlie normalizes historical games to the *current* franchise name (`"Memphis Grizzlies"`, `"Brooklyn Nets"`, `"Oklahoma City Thunder"`, `"Washington Wizards"`). A historical matchup between two renamed franchises has zero exact-name overlap between the two sources and would silently fail to match. Worse: the string `"Charlotte Hornets"` refers to two different real-world franchises depending on the season (the original 1988–2002 team, now the Pelicans lineage, vs. an unrelated 2014–present team, formerly the Bobcats) — a flat name-mapping can't disambiguate this by name alone.

**Resulting decision (approved by the user during design):** rather than fixing the matcher, make nba_api an **independent games source**, exactly the way `player_game_stats` already independently sources balldontlie and nba_stats without forcing a merge. This eliminates both the balldontlie rate limit and the team-rename matching risk for the historical range in one move, at the cost of `game_id` becoming a two-source space — the same trade-off already accepted for `player_id`/`player_key`.

## Findings (empirically verified during design, not assumed)

- **balldontlie rate limit**: real HTTP probe against `/games?seasons[]=1996` returned `x-ratelimit-limit: 5`, and a 5-request burst immediately produced `HTTP 429` with a `retry-after: 26` header. This is a real, currently-unhandled gap — `BallDontLieClient._get()` has zero rate-limit handling today (just `raise_for_status()`), which would previously have crashed on any run longer than 5 requests without anyone noticing (the 3-day pilot only ever made a handful of calls).
- **balldontlie supports season-level queries**: `/games?seasons[]=1996&per_page=100` returns the full 1996-97 season, paginated (~13 pages). Moot for this plan since balldontlie is no longer used for historical discovery, but confirms the API shape if ever revisited.
- **nba_api supports season-level queries** via `leaguegamefinder.LeagueGameFinder(season_nullable="1996-97", league_id_nullable="00", season_type_nullable=...)`. `season_type_nullable` cleanly separates `"Regular Season"` (1189 games for 1996-97), `"Playoffs"` (72 games), `"All Star"` (1 game — correctly excluded by never querying this type), and `"Pre Season"` (0 rows returned for 1996-97). No pagination needed — one call per season per type returns every row.
- **nba_api's `GAME_ID`** is a 10-character string (e.g. `"0029600001"` for regular season, `"0049600001"` for playoffs) whose leading-zero-stripped integer value falls in an ~8-digit range (e.g. 22,400,001–49,999,999 across the seasons sampled: 1996-97 and 2024-25). balldontlie's native `games.id` is currently ~1,038,000 and grows via a sequential counter with no documented ceiling — theoretically could reach into nba_api's numeric range over a long enough horizon, even though the two ranges don't currently overlap.
- **Real per-game box-score latency**, measured from the actual completed pilot run: ~1.2–1.5 seconds/game end-to-end (the `NBAStatsClient`'s `REQUEST_PACING_SECONDS = 0.6` sleep is a floor, not the observed rate — real network latency roughly doubles it).

## Goals

- Backfill real box-score and game data for every NBA game, 1996-97 season through 2025-26 season (last fully completed season as of 2026-09-03), sourced entirely from `nba_api`/`stats.nba.com`.
- Keep the operation local-only, human-driven, one season (or a few) at a time, resumable via checkpoint if interrupted — matching the existing accepted operational pattern for this source.
- Preserve every existing consumer's assumptions about `games`/`player_game_stats` column shapes and types (`api/`, `web/`, `quality/`) — additive, not breaking, for anything outside the `nba_stats`-source rows themselves.

## Non-goals (explicit deferrals, not omissions)

- **No backfill of balldontlie's own historical `games` list.** Since matching is no longer used, there's no functional need for it in this plan. It would only matter for future cross-source reconciliation (comparing two independent games records for the Quality Observatory), which stays deferred — same posture as the existing `player_key` gap.
- **No pre-1996-97 seasons.** Real, structural data gaps (steals/blocks untracked before 1973-74, no three-point line before 1979-80) make this a different problem (schema for missing categories, not just more time) — out of scope here.
- **No cross-source `game_id` reconciliation.** balldontlie's and nba_api's `game_id`s remain two independent spaces in the same `games` table, exactly like `player_id` today. A future reconciliation pass (keyed by date + team names, now that both are real, non-empty sources) is real work for later, not attempted here.
- **No automatic multi-season orchestration/retry loop.** The human invokes one season (or a deliberately chosen batch) per sitting; each invocation's internal checkpoint protects against a mid-season crash, but nothing automatically retries after a hard failure or runs unattended across seasons.

## Architecture

```
nba_api (stats.nba.com), season-scoped
  │
  │ LeagueGameFinder(season_nullable, season_type_nullable="Regular Season")
  │ LeagueGameFinder(season_nullable, season_type_nullable="Playoffs")
  ▼
NBAStatsClient.get_games_for_season(season) -> list[dict]
  (groups the two team-rows-per-GAME_ID into one game dict each: game_id,
   game_date, season, postseason, status, home_team, away_team, home_score,
   away_score — home/away derived from the MATCHUP field's "vs."/"@")
  │
  ▼
raw_pulls(source="nba_stats", endpoint="game", payload={...above...})
  │
  ▼ (per game, one more real API call)
NBAStatsClient.get_boxscore(nba_game_id) -> list[dict]  (unchanged from pilot)
  │
  ▼
raw_pulls(source="nba_stats", endpoint="boxscore_traditional",
          payload={"game_id": <offset nba_game_id>, "player_stats": [...]})
  │
  ▼
stg_games_nba.sql (new)          stg_player_game_stats_nba.sql (modified:
  │                                game_id key, no more balldontlie_game_id)
  ▼                                │
games mart = UNION ALL              ▼
  (stg_games balldontlie            player_game_stats mart = UNION ALL
   + stg_games_nba)                   (unchanged shape, new game_id source)
```

## `game_id` collision-avoidance scheme

nba_api's own `GAME_ID`, cast straight to bigint, could theoretically collide with balldontlie's native sequential `games.id` over a long enough time horizon (see Findings). Following the same precedent already established for `stat_id`'s composite key, nba_api-sourced `game_id` values get a fixed, documented offset applied at ingestion time (in the Python client, alongside the payload, so dbt does a straight passthrough — no computation in SQL):

```python
# ingestion/src/ingestion/sources/nba_stats.py
NBA_GAME_ID_OFFSET = 100_000_000_000  # 100 billion

def offset_game_id(nba_game_id: str) -> int:
    """Guarantees nba_api-sourced game_id never collides with balldontlie's
    native sequential games.id (currently ~1,038,000 and growing) — offset
    is ~96,000x balldontlie's current id, far more headroom than that
    sequence will plausibly reach.
    """
    return NBA_GAME_ID_OFFSET + int(nba_game_id)
```

**Correction found while writing the implementation plan** (the original draft of this spec used a 1-trillion offset): `stg_player_game_stats_nba.sql`'s existing `stat_id` composite key is `game_id * 10,000,000 + player_id` — multiplying a 1-trillion-scale `game_id` by 10,000,000 overflows Postgres `bigint` (max ~9.22×10^18) by several orders of magnitude. A 100-billion offset keeps `stat_id`'s maximum realistic value (~1.0×10^18, worked out from an 8-digit raw nba_api game id and a 7-digit player id) within bigint with ~9x headroom, while still sitting ~96,000x above balldontlie's current native `games.id` (~1,038,000) — this is the real, checked constant, not the 1-trillion one mentioned earlier in this document's first draft.

Applied once, in the client, to both the `game` payload's `game_id` and the `boxscore_traditional` payload's `game_id` (so the two payload types agree on the same offset id for the same real game). A `unique` dbt test on the `games` mart's `game_id` column (across the `UNION ALL`) empirically verifies no real collision, rather than trusting the scheme blindly.

## Home/away/score derivation

`LeagueGameFinder` returns one row per team per game (two rows per `GAME_ID`), each with a `MATCHUP` field like `"CHI vs. UTA"` (CHI is home) or `"CHI @ UTA"` (CHI is away — the row is written from the away team's perspective). `get_games_for_season` groups by `GAME_ID`, and for each pair picks the row whose `MATCHUP` contains `"vs."` as home and the other as away, taking `PTS` from each row as that team's score. `status` is hardcoded to `"Final"` (a historical backfill only ever covers completed games — no live/in-progress state is possible here). `postseason` is set by which `season_type_nullable` sub-call produced the row (`True` for `"Playoffs"`, `False` for `"Regular Season"`) — passed down from the flow, not derived from data.

## Flow redesign: `backfill_nba_stats_flow`

- **Parameters change** from `start_date`/`end_date` to `start_season`/`end_season` (int, balldontlie-style season-year convention — `1996` means "1996-97"). A human invokes this with one season (`start_season == end_season`) or a small range per sitting, per the earlier decision to run this manually rather than build multi-season orchestration.
- **`ExistingGamesReader` Protocol and its Gold-table read are removed entirely** — there's no more balldontlie `games` table dependency, and no more `quality.reconciliation.match_games_by_team_overlap` usage for this flow. The `quality` editable path dependency in `ingestion/pyproject.toml` can be removed if nothing else in `ingestion` still uses it (verify before removing — check other flows first).
- Per season in the requested range:
  1. One `get_games_for_season(season)` call (2 real API calls internally: Regular Season + Playoffs) returns every game's full metadata for that season — no more per-day discovery calls.
  2. Group games by `game_date`.
  3. For each date with games (skipping the checkpoint-resume-covered ones, same logic as today): write one `game`-payload `RawPull` per game, then call `get_boxscore(nba_game_id)` and write one `boxscore_traditional`-payload `RawPull` per game.
  4. Advance the checkpoint to that date once every game on it is fully processed (games record + box score) — unchanged semantics from today, just fed by an in-memory season index instead of a live per-day API call.
- **Failure handling is unchanged in spirit**: if any call within a date's processing raises (either the games discovery — now once per season rather than once per day — or a box-score fetch), the checkpoint does not advance past that date, and the exception propagates with a message identifying the failing date/game. Re-running the same `start_season` resumes cleanly from the last fully-completed date within that season.
- **Checkpoint reset required**: the existing `backfill_checkpoints` row for `flow_name="backfill_nba_stats"` (`last_pulled_date=2024-01-03`) reflects the old pilot under the old payload schema and must be deleted before the first real run under this redesign, so the flow starts fresh at season 1996's first date rather than treating 2024-01-03 as already-done progress.

## Pilot data cleanup

The 26 `raw_pulls` rows from the 2024-01-01–01-03 pilot (`source='nba_stats'`) use the old `balldontlie_game_id`-keyed payload shape and are incompatible with the new schema. Delete them (and the checkpoint row above) before the first new-schema run; `dbt run` will naturally regenerate `player_game_stats`'s derived rows as empty until the new backfill re-covers that window as part of the 1996-97 season run. This is a clean cutover, not a dual-schema-support effort — approved by the user during design rather than maintaining parsing logic for both shapes.

## dbt changes

- **New**: `dbt/models/staging/stg_games_nba.sql` — parses `raw_pulls` where `source='nba_stats' and endpoint='game'`, same de-dup pattern (`row_number() over (partition by game_id order by pulled_at desc)`) as every other staging model. Target columns match `stg_games.sql` exactly: `game_id, game_date, season, status, postseason, home_team, away_team, home_score, away_score, pulled_at`.
- **Modified**: `dbt/models/marts/games.sql` — becomes `select ... from {{ ref('stg_games') }} union all select ... from {{ ref('stg_games_nba') }}`, mirroring `player_game_stats.sql`'s existing two-source pattern. Add a `unique` + `not_null` dbt test on the mart's `game_id` (empirical collision check, per the offset scheme above).
- **Modified**: `dbt/models/staging/stg_player_game_stats_nba.sql` — `game_id` now comes from `payload->>'game_id'` directly (nba_api's own offset id), not `payload->>'balldontlie_game_id'`.
- **New/modified `.yml` schema files** for both, following existing conventions (column descriptions, `not_null`/`unique` tests, at least one unit test covering the home/away/`MATCHUP` derivation with a real-shaped fixture).

## Testing

- **Client** (`ingestion/tests/test_nba_stats.py`): mock `LeagueGameFinder` for `get_games_for_season` — cover the Regular Season/Playoffs split (two separate calls, correctly tagged `postseason`), `GAME_ID` grouping into one game dict, home/away derivation from `MATCHUP` (`"vs."` vs `"@"`), and the `game_id` offset function directly (unit-testable in isolation).
- **Flow** (`ingestion/tests/test_backfill_nba_stats_flow.py`): fakes for the redesigned `NBAGameSource` Protocol (now `get_games_for_season`/`get_boxscore`, no more `ExistingGamesReader`) — verify per-date writes of both `game` and `boxscore_traditional` payloads, checkpoint-per-date advance, and the existing mid-date-failure/non-advance case (still real and still required — a season-level discovery call failing, or a box-score call mid-season failing, must not corrupt checkpoint state for already-completed dates).
- **dbt**: `dbt parse --no-partial-parse` / `dbt compile --no-populate-cache` as always, but per `[[dbt-offline-verification-blind-spot]]` (project memory), these cannot substitute for a real `dbt run` — the plan's verification section must require at least one real `dbt run` against a real Postgres with real pilot-season data before declaring this done, not just clean parse/compile output.
- **Real verification** (cannot happen in any sandbox — no network access): the human runs one full pilot season for real first (recommend 1996-97, already spot-checked during design research) before committing to all 30 — confirming real games write correctly, real box scores match the new `game_id` scheme, and `dbt run` produces the expected non-empty, non-duplicated rows.

## Operational runbook (for the human, once implemented)

```bash
# Per season, e.g. 1996-97:
cd ingestion && PYTHONPATH=src:../db/src uv run python -c \
  "from ingestion.flows.backfill_nba_stats_flow import backfill_nba_stats_flow; \
   print(backfill_nba_stats_flow(start_season=1996, end_season=1996))"
cd dbt && DBT_PROFILES_DIR=. uv run dbt run
```

No more balldontlie-backfill-first ordering dependency (removed along with the Gold-table read). Repeat per season (or a small batch of seasons) across as many sittings as needed; each invocation's checkpoint protects against a mid-run interruption within that invocation's own date range.

**Runtime**: ~34,500 total games across 30 seasons (rough estimate — season game counts vary with lockouts/expansion: 1996-97 had 1,189 regular-season + 72 playoff games; 2024-25 had 1,230 regular-season + 84 playoff games — both counts verified directly against the real API during design). At the real observed ~1.2–1.5s/game, full coverage is **~12.5 hours of nba_api calls total**, distributed across however many sittings the human chooses. Season-level game discovery (2 calls/season, ~60 calls total) is comparatively instant.
