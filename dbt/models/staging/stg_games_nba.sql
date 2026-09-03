-- Silver staging model: parses nba_api's (stats.nba.com) games payload out
-- of the Bronze `raw_pulls` table for source='nba_stats', endpoint='game'
-- (docs/prd.md §04, §06), and de-duplicates to the most-recently-pulled
-- version of each game_id -- same pattern as stg_games.sql (the
-- balldontlie sibling).
--
-- nba_api is an INDEPENDENT games source, not matched onto balldontlie's
-- game_id space -- see docs/superpowers/specs/2026-09-03-full-nba-history-
-- backfill-design.md for why (renamed-franchise team-name-matching risk,
-- balldontlie's 5 req/min rate limit). `game_id` here is nba_api's own
-- GAME_ID, offset by `ingestion.sources.nba_stats.NBA_GAME_ID_OFFSET`
-- (100 billion) at ingestion time so it can never collide with
-- balldontlie's native sequential games.id -- see that module's
-- `offset_game_id` for the full guarantee.
--
-- Payload shape (source='nba_stats', endpoint='game'), written by
-- backfill_nba_stats_flow.py -- one row per game, not a paginated "data"
-- array like balldontlie's shape, so no jsonb_array_elements needed:
-- {
--   "game_id": 100022300500,
--   "game_date": "2024-01-01",
--   "season": 2023,
--   "postseason": false,
--   "status": "Final",
--   "home_team": "Atlanta Hawks",
--   "away_team": "Boston Celtics",
--   "home_score": 121,
--   "away_score": 105
-- }

with raw_game_pulls as (

    select
        payload,
        pulled_at
    from {{ source('raw', 'raw_pulls') }}
    where source = 'nba_stats'
      and endpoint = 'game'

),

typed as (

    select
        (payload ->> 'game_id')::bigint as game_id,
        (payload ->> 'game_date')::date as game_date,
        (payload ->> 'season')::int as season,
        payload ->> 'status' as status,
        (payload ->> 'postseason')::boolean as postseason,
        payload ->> 'home_team' as home_team,
        payload ->> 'away_team' as away_team,
        (payload ->> 'home_score')::int as home_score,
        (payload ->> 'away_score')::int as away_score,
        pulled_at
    from raw_game_pulls

),

deduped as (

    select
        *,
        row_number() over (
            partition by game_id
            order by pulled_at desc
        ) as rn
    from typed

)

select
    game_id,
    game_date,
    season,
    status,
    postseason,
    home_team,
    away_team,
    home_score,
    away_score,
    pulled_at
from deduped
where rn = 1
