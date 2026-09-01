-- Silver staging model: parses/types one row per game out of the Bronze
-- `raw_pulls` JSONB payloads for source='balldontlie', endpoint='games'
-- (docs/prd.md §04, §06), and de-duplicates to the most-recently-pulled
-- version of each game.
--
-- `raw_pulls` is append-only, so the same game.id can appear across many
-- pulls (e.g. re-pulled while live, or re-pulled after final). We keep only
-- the latest pull per game_id here; the mart layer is a straight passthrough
-- of this de-duplication for now (see models/marts/games.sql).
--
-- Assumed payload shape (balldontlie v1 GET /games, NOT yet verified against
-- real ingested rows):
-- {
--   "data": [
--     {
--       "id": 15908,
--       "date": "2024-01-01T00:00:00.000Z",
--       "season": 2023,
--       "status": "Final",
--       "postseason": false,
--       "home_team_score": 121,
--       "visitor_team_score": 105,
--       "home_team": {"id": 1, "abbreviation": "ATL", "full_name": "Atlanta Hawks"},
--       "visitor_team": {"id": 2, "abbreviation": "BOS", "full_name": "Boston Celtics"}
--     }
--   ],
--   "meta": {"next_cursor": 123, "per_page": 100}
-- }

with raw_games_pulls as (

    select
        payload,
        pulled_at
    from {{ source('raw', 'raw_pulls') }}
    where source = 'balldontlie'
      and endpoint = 'games'

),

-- One `raw_pulls` row holds a full response page (payload.data is an array
-- of games) -> explode it so downstream CTEs operate one row per game.
exploded as (

    select
        game_json,
        pulled_at
    from raw_games_pulls
    cross join lateral jsonb_array_elements(payload -> 'data') as game_json

),

typed as (

    select
        (game_json ->> 'id')::bigint as game_id,
        -- balldontlie dates are ISO-8601 UTC instants (e.g. "...T00:00:00.000Z");
        -- cast to timestamptz first, then take the date part, rather than
        -- casting the raw string straight to `date`.
        (game_json ->> 'date')::timestamptz::date as game_date,
        (game_json ->> 'season')::int as season,
        game_json ->> 'status' as status,
        (game_json ->> 'postseason')::boolean as postseason,
        game_json -> 'home_team' ->> 'full_name' as home_team,
        game_json -> 'visitor_team' ->> 'full_name' as away_team,
        (game_json ->> 'home_team_score')::int as home_score,
        (game_json ->> 'visitor_team_score')::int as away_score,
        pulled_at
    from exploded

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
