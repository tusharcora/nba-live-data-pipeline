# NBA Stats Historical Box-Score Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development — one fresh specialized subagent ("employee") per task below, reviewed and merged by a "boss" subagent per team before human sign-off, exactly as executed for every prior round. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate `player_game_stats` with real data for the first time in this project's history, using `nba_api` (a Python client for `stats.nba.com`) as a local-only historical backfill, unblocking Historical Explorer's box-score view and the planned Statmuse-style natural-language stats feature.

**Architecture:** A new, independent ingestion source following every convention already established in `ingestion/`. `nba_api`'s `LeagueGameFinder`/`BoxScoreTraditionalV2` supply real box scores; these are matched to already-ingested balldontlie games (by team-name overlap, reusing `quality.reconciliation.match_games_by_team_overlap`) so the resulting Bronze payload carries balldontlie's `game_id` directly — meaning the new dbt staging model needs zero cross-source logic and the existing UI/checks need zero changes to consume it.

**Tech Stack:** `nba_api` (new `ingestion` dependency). No other new dependencies.

**Spec:** `docs/prd.md` §3 (data sources — this backfill deliberately does *not* reopen the "NBA Stats API as primary" rejection documented there; it operates entirely outside that constraint by being local-only), `docs/PROGRESS.md`'s Known Issues (the `player_game_stats`-is-empty entry this closes).

## Global Constraints

- **New dependency**: `nba_api` added to `ingestion/pyproject.toml` (pure Python, depends on `requests`/`numpy` — no compiled-binary risk).
- **Local-only, never scheduled/deployed.** Nothing in this plan wires this into a Prefect deployment, CI, or any cloud-triggered path. Invoked the same ad hoc way as `backfill_flow`/`backfill_stats_flow` (`PYTHONPATH=src:../db/src:../quality/src uv run python -c "..."`), documented as needing to run from the developer's own machine — `stats.nba.com` actively blocks datacenter IPs (AWS/GCP/Azure), which is exactly why this can't be a live/scheduled job.
- **This is a deliberate, named ToS trade-off, not a hidden one.** Working around `stats.nba.com`'s bot protection from a residential IP with spoofed headers is very likely a Terms of Service violation regardless of IP origin. `nba_api` is a widely-used community tool that does exactly this. For a portfolio project this is a common, low-stakes, acceptable choice — document it as an explicit decision in `docs/PROGRESS.md` once merged, the same way the paid-tier and stretch-model decisions were documented, not as an implicit footnote about request pacing.
- **Rate-limit pacing (~600ms between real NBA.com requests) lives inside the client itself** (`time.sleep` between calls) — never left to the caller to remember.
- **The realistic failure mode is a mid-run block** (403 / CAPTCHA / connection reset from Akamai), not a clean empty result. If any call within a date's processing raises, do **not** advance the checkpoint for that date — let the exception propagate with a message identifying the failing date/game, so re-running resumes cleanly from the last fully-completed date. `raw_pulls`' append-only nature + dbt's `row_number()` dedup make any harmless re-fetch of an already-succeeded game a no-op.
- **Runtime expectations, stated in the PR so the human isn't surprised:** ~600ms/request minimum, one call per date plus one per matched game. The project's existing 3-day/26-game window: ~20-30 real seconds. A full season (~1,230 games, ~170 game days): tens of minutes minimum.
- **Reuse `quality.reconciliation.match_games_by_team_overlap` directly — do not reimplement it.** `ingestion` gains `quality` as an editable path dependency in `pyproject.toml`'s `[tool.uv.sources]`, mirroring the existing `db` path-dependency entry. **But this matcher has never been tested against `stats.nba.com`'s team-name format** (only balldontlie/public-feed shapes) — Employee 1 must verify real overlap (or build a small, explicit 30-team canonical name mapping if there isn't clean overlap) before trusting it.
- **Testing note:** `nba_api`'s endpoint classes wrap their own HTTP calls internally (custom headers needed to get past basic bot detection) and don't expose a raw `httpx`/`requests` call to intercept. Tests mock the `nba_api.stats.endpoints.LeagueGameFinder`/`BoxScoreTraditionalV2` classes themselves — never a real network call, same spirit as `CLAUDE.md`'s "mock httpx.get" convention, different interception point given a different library boundary.
- **`cached_json`'s fail-open pattern deliberately does not apply here** — that pattern exists for a served request path falling back to direct computation on a cache miss; this is a one-shot local script with no request/response cycle to fail open around. Noted explicitly so the omission reads as considered, not missed.
- **New ordering dependency**: the new flow reads balldontlie's already-dbt-built Gold `games` table (to know what to match against). Real run order: balldontlie backfill → `dbt run` → nba_stats backfill → `dbt run` again. Document this in the PR and in `docs/PROGRESS.md` — no prior flow has read a Gold table as an input.
- **Player identity across sources is a real gap, addressed at the schema level, not solved this round.** `nba_api`'s `PLAYER_ID` and balldontlie's `player_id` are different ID spaces; the mart is a straight `UNION ALL` with no cross-source player dedup. Both staging models gain a `player_key` column (via `ingestion.normalization.normalize_player_key`, already built for exactly this purpose) so the join key needed for real reconciliation later already exists in the data — actual reconciliation logic is explicitly out of scope this round.
- **Explicitly deferred, not omitted:** wiring this new source into `quality/`'s reconciliation or volumetric checks is not in this round. State this as a deliberate deferral in the PR body and `docs/PROGRESS.md`.
- Follow the exact Protocol-injection DI pattern from `backfill_flow.py`/`backfill_stats_flow.py` for every new flow parameter — Prefect builds its parameter schema from type hints at decoration time; a bare `Protocol` or concrete-class annotation breaks this.
- `raw_pulls` is append-only — the new staging model must de-duplicate via `row_number() over (partition by ... order by pulled_at desc)`, matching every existing staging model.

---

## Team: `nba-stats-backfill` (2 employees, dispatched sequentially — Employee 2 needs Employee 1's real payload shape)

### Employee 1: `nba-stats-client-and-flow`

**Files:** Create: `ingestion/src/ingestion/sources/nba_stats.py`, `ingestion/src/ingestion/flows/backfill_nba_stats_flow.py`. Modify: `ingestion/pyproject.toml` (add `nba_api`; add `quality` as an editable path source mirroring the existing `db` entry). Test: `ingestion/tests/test_nba_stats.py`, `ingestion/tests/test_backfill_nba_stats_flow.py`.

**Task:**
1. Read `ingestion/src/ingestion/flows/backfill_stats_flow.py` and `quality/src/quality/volumetric.py`'s `SQLAlchemyGoldReader` in full before writing anything — this task's structure should look like a recombination of existing patterns, not a new design.
2. `NBAStatsClient` in `nba_stats.py`:
   - `get_games_for_date(date_str: str) -> list[dict]`: wraps `nba_api.stats.endpoints.leaguegamefinder.LeagueGameFinder`, filtered to the given date. It returns one row *per team* (two rows per game) — group by `GAME_ID` and return one dict per game carrying both team names. Read the actual `.get_normalized_dict()` output first to confirm real column names (e.g. `TEAM_NAME`, `MATCHUP`) — don't guess at the schema.
   - `get_boxscore(nba_game_id: str) -> list[dict]`: wraps `nba_api.stats.endpoints.boxscoretraditionalv2.BoxScoreTraditionalV2`, returns the `PlayerStats` result set via `.get_normalized_dict()["PlayerStats"]` — an already-keyed list of dicts. Do not use `.get_dict()`'s raw `headers`/`rowSet` shape (that would push fragile positional parsing into dbt).
   - A named module-level constant for the ~600ms sleep, with a comment citing where that pacing number came from (community-found safe pacing, per `github.com/swar/nba_api` issue discussion) — `time.sleep()` between every real call this client makes.
3. **Before wiring in the matcher:** verify `match_games_by_team_overlap` actually works against `stats.nba.com`'s team-name format vs. balldontlie's — e.g. print/compare real team-name strings from both sources for a couple of already-known real games (the project's existing 2024-01-01..2024-01-03 backfill window). If there's no clean set-overlap, build a small, explicit 30-team canonical name mapping (hardcoded — this is not a dynamic problem) to normalize both sides before matching. Document which case applied and why in the PR.
4. `backfill_nba_stats_flow.py`, mirroring `backfill_stats_flow.py`'s structure exactly:
   - New `@runtime_checkable` Protocols: `NBAGameSource` (`get_games_for_date`/`get_boxscore`, matching the client) and `ExistingGamesReader` (`get_games_for_date(date) -> list[tuple[str, set[str]]]` — game_id + team-name set, read from the Gold `games` table via `Table(..., autoload_with=engine)`, same reflected-table pattern as `SQLAlchemyGoldReader`; this is a new kind of reader for `ingestion` since it reads a Gold, dbt-owned table rather than writing Bronze — comment why).
   - New, independent checkpoint: `CHECKPOINT_FLOW_NAME = "backfill_nba_stats"` — never shares a row with `"backfill_flow"`/`"backfill_stats"`.
   - Per date in range: read balldontlie's games for that date (`ExistingGamesReader`), read NBA.com's games for that date (`NBAGameSource.get_games_for_date`), match them (step 3's approach), then for each matched pair call `get_boxscore(nba_game_id)` and write one `RawPull(source="nba_stats", endpoint="boxscore_traditional", payload={"balldontlie_game_id": <int>, "player_stats": [...]})` via the existing `RawPullSink`. Log (don't error on) any NBA.com game with no balldontlie match.
   - **Failure handling:** if any call within a date's processing raises, do not advance the checkpoint for that date; let the exception propagate with a message naming the failing date/game.
5. Tests (mock `LeagueGameFinder`/`BoxScoreTraditionalV2` directly, per Global Constraints — never a real network call): the team-name grouping logic in `get_games_for_date`; a full flow run with fakes for all three Protocols proving the write payload shape and that the checkpoint advances independently of the other two backfill flows; a case where an NBA.com game has no balldontlie match (confirm it's skipped, not written with a null/fabricated game_id); **a mid-date failure case proving the checkpoint does NOT advance past a date where a box-score fetch raised**.

**Skills for this task:** superpowers:test-driven-development.

### Employee 2: `dbt-nba-stats-staging-and-mart`

**Files:** Create: `dbt/models/staging/stg_player_game_stats_nba.sql`, `dbt/models/staging/stg_player_game_stats_nba.yml`. Modify: `dbt/models/marts/player_game_stats.sql`, and (to add the matching `player_key` column for union parity) `dbt/models/staging/stg_player_game_stats.sql` — only if this doesn't require touching the balldontlie ingestion path itself, which is out of scope here.

**Task:**
1. **Once Employee 1's PR is merged, read its actual code/test fixtures for the real payload shape** — don't assume field names. `payload` is `{"balldontlie_game_id": <int>, "player_stats": [{...nba_api-normalized keys...}]}`.
2. `stg_player_game_stats_nba.sql`: parse `raw_pulls` where `source = 'nba_stats' and endpoint = 'boxscore_traditional'`. Target columns match the existing `stg_player_game_stats` model plus one new column: `stat_id, game_id, player_id, player_first_name, player_last_name, player_key, team, points, rebounds, assists, steals, blocks, turnovers, minutes_played, pulled_at`.
   - `game_id` = `payload->>'balldontlie_game_id'` directly — no matching logic here, that already happened at ingestion time.
   - `stat_id`: nba_api rows have no standalone stat ID the way balldontlie's do. Before inventing a synthetic scheme (e.g. `'nba_' || balldontlie_game_id || '_' || player_id`), check how `stat_id` is actually used downstream (a real join target anywhere, or just a dedup/display key?) — don't assume it doesn't matter.
   - `player_first_name`/`player_last_name`: nba_api's `PLAYER_NAME` is a single "First Last" string — split on the *last* space. Include a real test fixture with a suffixed name (e.g. `"Gary Trent Jr."`) — this project has a tested normalization utility (`ingestion.normalization`) that already handles suffix formatting; check it before hand-rolling suffix logic here.
   - `player_key`: computed via `ingestion.normalization.normalize_player_key`. dbt-core cannot run arbitrary Python inline in a `select` — this almost certainly means the normalized key needs to be computed in the *ingestion* layer (written into the Bronze payload alongside `player_stats`) so dbt just extracts a plain JSON field like every other column. If Employee 1's merged PR doesn't already include this, flag it to the boss rather than trying to solve Python-in-SQL here — it's a small follow-up to Employee 1's flow, not something this task can complete alone.
   - `minutes_played`: adapt the existing model's dual-format parser (bare integer string vs `"MM:SS"`) — confirm nba_api's real `MIN` format against Employee 1's actual fixtures before assuming either shape.
   - De-duplicate via `row_number() over (partition by stat_id order by pulled_at desc, pull_id desc)`, matching the existing model exactly.
3. Update `player_game_stats.sql` to `select ... from {{ ref('stg_player_game_stats') }} union all select ... from {{ ref('stg_player_game_stats_nba') }}`, including `player_key` on both sides (add it to the existing balldontlie staging model too, for union column parity, even though its rows are empty in practice). **Do not build cross-source dedup/priority logic** ("prefer balldontlie if both exist") — balldontlie's path is realistically permanently empty on the current API plan, so there's no real case to handle yet; note this as a deliberate simplification, not an oversight.
4. Verify via `dbt parse --no-partial-parse` and `dbt compile --no-populate-cache` (per `CLAUDE.md` — no live DB needed). Add a `.yml` schema file for the new staging model (column descriptions, not-null tests on `game_id`/`player_id` at minimum).

**Skills for this task:** superpowers:systematic-debugging if the real nba_api payload shape doesn't match what's assumed here — this project has hit exactly this "assumed shape wrong against real data" failure mode twice before with balldontlie's own `/stats` endpoint.

---

## Verification (boss, before reporting to the human)

- `ingestion`: `PYTHONPATH=src:../db/src:../quality/src uv run pytest -v` (existing 69 + new nba_stats/flow tests, including the mid-date-failure/checkpoint test) — no real network calls anywhere in the suite.
- `dbt`: `dbt parse --no-partial-parse` and `dbt compile --no-populate-cache` clean.
- **Cannot be verified in any sandbox, by design:** an actual real run against `stats.nba.com` (blocked from cloud IPs; these sandboxes have no network access regardless). The human running this on their own machine proves it end-to-end: real games matched, real box scores landing in `raw_pulls`, a real mid-run interruption (if one occurs) resuming correctly, and a real `dbt run` afterward producing non-empty `player_game_stats` rows for the first time in this project's history.
- State plainly in the PR: the exact invocation, e.g. `cd ingestion && PYTHONPATH=src:../db/src:../quality/src uv run python -c "from ingestion.flows.backfill_nba_stats_flow import backfill_nba_stats_flow; print(backfill_nba_stats_flow(start_date='2024-01-01', end_date='2024-01-03'))"`, followed by `make dbt-run` — matching the exact window already backfilled from balldontlie. Include the runtime-expectation numbers from Global Constraints.

## Execution

Single boss branch (`nba-stats-backfill`), two employees dispatched sequentially. Same GitHub-PR workflow as every prior round: real branches, real PRs, boss reviews and merges into the boss branch, human sign-off gate before merge to `main`. Once merged and the human has run the backfill for real, the Statmuse feature (next, separately planned) builds on real player-level data from day one.
