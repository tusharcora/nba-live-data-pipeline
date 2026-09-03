-- Silver staging model: parses balldontlie's /stats endpoint payload out of
-- the Bronze `raw_pulls` table into one row per player/game box-score line
-- (docs/prd.md §04, §06).
--
-- `raw_pulls` is append-only — the same stat-line `id` can appear in more
-- than one pull (a re-pull picking up a correction/update to an in-progress
-- or since-finalized game). We de-duplicate to the most-recently-pulled
-- version of each stat line via row_number() (Postgres has no QUALIFY).
--
-- Payload shape (balldontlie v1 /stats) — CONFIRMED against a real ingestion
-- path: Employee A1's `BallDontLieClient.get_stats_pages` /
-- `backfill_stats_flow` (PR #36, merged) writes exactly this JSON verbatim
-- into `raw_pulls.payload` (Bronze append-only "store the whole API
-- response" contract), and A1's mocked-`httpx` test fixtures
-- (`ingestion/tests/test_balldontlie_stats.py`) plus an independent
-- re-check against the live docs at https://docs.balldontlie.io confirm the
-- field names/paths below. This has NOT been run against a live
-- Postgres/dbt build in this sandbox (no live DB available here) — verified
-- offline only, via `dbt parse --no-partial-parse` and
-- `dbt compile --no-populate-cache`.
-- {
--   "data": [
--     {
--       "id": 890321, "min": "30", "pts": 28, "reb": 7, "ast": 9,
--       "stl": 1, "blk": 0, "turnover": 3,
--       "game": {"id": 15908, ...},
--       "player": {"id": 237, "first_name": "Luka", "last_name": "Dončić"},
--       "team": {"id": 7, "full_name": "Dallas Mavericks", ...}
--     }
--   ],
--   "meta": {...}
-- }
--
-- All fields this model extracts (stat id/game.id/player.id/
-- player.first_name/player.last_name/team.full_name/pts/reb/ast/stl/blk/
-- turnover) match the real shape as-is. The one real discrepancy found: the
-- header previously assumed "min" always comes back "MM:SS" (e.g.
-- "34:12"). The live docs' own example response shows a plain
-- minutes-only string with no colon/seconds ("min": "30") — see the
-- `minutes_played` extraction below, which now handles both shapes.
-- balldontlie has historically been inconsistent about this field across
-- query modes/seasons, so both a bare-integer string ("30") and an
-- "MM:SS" string (e.g. "34:12", possibly still returned for some
-- older/different data) are handled; anything else (null, '', garbage)
-- still safely returns null, unchanged from before.
--
-- `player_key` (added for union column parity with the sibling
-- `stg_player_game_stats_nba` model, which needs it for cross-source
-- player matching) is always NULL here — balldontlie's `/stats` payload
-- carries no such field in Bronze, and this is dbt-only scope: computing
-- one from `player.first_name`/`player.last_name` would require touching
-- the balldontlie ingestion path (out of scope) or duplicating
-- `ingestion.normalization.normalize_player_key` in SQL for a source that
-- doesn't need it yet (balldontlie's `player_game_stats` path is
-- realistically permanently empty on the current API plan — see
-- docs: `player_game_stats requires balldontlie's paid ALL-STAR tier`).
-- Deliberate simplification, not an oversight.

with raw_stat_pulls as (

    select
        id as pull_id,
        pulled_at,
        jsonb_array_elements(payload -> 'data') as stat_line
    from {{ source('raw', 'raw_pulls') }}
    where source = 'balldontlie'
      and endpoint = 'stats'

),

typed as (

    select
        pull_id,
        (stat_line ->> 'id')::bigint as stat_id,
        (stat_line -> 'game' ->> 'id')::bigint as game_id,
        (stat_line -> 'player' ->> 'id')::bigint as player_id,
        stat_line -> 'player' ->> 'first_name' as player_first_name,
        stat_line -> 'player' ->> 'last_name' as player_last_name,
        stat_line -> 'team' ->> 'full_name' as team,
        (stat_line ->> 'pts')::int as points,
        (stat_line ->> 'reb')::int as rebounds,
        (stat_line ->> 'ast')::int as assists,
        (stat_line ->> 'stl')::int as steals,
        (stat_line ->> 'blk')::int as blocks,
        (stat_line ->> 'turnover')::int as turnovers,
        -- "min" comes back either as a plain minutes-only string (e.g.
        -- "30" — confirmed as the current real shape against
        -- docs.balldontlie.io and A1's test fixtures) or, per balldontlie's
        -- historical inconsistency across query modes/seasons, possibly
        -- still as an "MM:SS" string (e.g. "34:12") for some older/
        -- different data. Handle both: a bare integer string converts
        -- straight to decimal minutes ("30" -> 30); an "MM:SS" string
        -- splits on ':' ("34:12" -> 34 + 12/60 = 34.2). Guard against
        -- null/empty/anything else (malformed, or a player who didn't
        -- play) so this never errors the model — it just returns null,
        -- same safety as before.
        case
            when nullif(trim(stat_line ->> 'min'), '') is null then null
            when (stat_line ->> 'min') ~ '^[0-9]+:[0-9]+$' then
                split_part(stat_line ->> 'min', ':', 1)::numeric
                + split_part(stat_line ->> 'min', ':', 2)::numeric / 60
            when (stat_line ->> 'min') ~ '^[0-9]+$' then
                (stat_line ->> 'min')::numeric
            else null
        end as minutes_played,
        pulled_at

    from raw_stat_pulls

),

deduped as (

    select
        typed.*,
        row_number() over (
            partition by stat_id
            -- pull_id (raw_pulls' own serial PK) is the tiebreaker for the
            -- rare case where two pulls land the same pulled_at timestamp
            -- (e.g. second-granularity clocks during a fast poll loop) —
            -- a higher pull_id is always the later insert.
            order by pulled_at desc, pull_id desc
        ) as rn
    from typed

)

select
    stat_id,
    game_id,
    player_id,
    player_first_name,
    player_last_name,
    -- Always NULL on this side — see header note above.
    null::text as player_key,
    team,
    points,
    rebounds,
    assists,
    steals,
    blocks,
    turnovers,
    minutes_played,
    pulled_at
from deduped
where rn = 1
