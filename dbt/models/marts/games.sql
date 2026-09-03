-- Gold `games` table (docs/prd.md §06): 1 row per game, reconciled final
-- scores/status/schedule, read by the API and (later) the prediction model.
--
-- UNION ALL of two independent Bronze sources -- balldontlie
-- (`stg_games`) and nba_api's local-only historical backfill
-- (`stg_games_nba`), same pattern as `player_game_stats.sql`. No
-- cross-source dedup/priority logic: the two sources' game_id spaces never
-- overlap by construction (`stg_games_nba`'s game_id is offset -- see that
-- model's header), so this is a straight union, not a merge. Further
-- cross-source reconciliation (matching the same real game across both
-- sources) remains deferred, same posture as player_game_stats.sql's
-- player_key gap -- see docs/superpowers/specs/2026-09-03-full-nba-history-
-- backfill-design.md.

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
    pulled_at as source_pulled_at
from {{ ref('stg_games') }}

union all

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
    pulled_at as source_pulled_at
from {{ ref('stg_games_nba') }}
