-- Gold mart: `player_game_stats` (docs/prd.md §06) — 1 row per player/game
-- box-score line. Passthrough of the Silver staging model for now;
-- cross-source reconciliation (balldontlie vs. the public feed) is a later
-- week's work once the public feed is also landing player-level box scores
-- in `raw_pulls`.

select
    stat_id,
    game_id,
    player_id,
    player_first_name,
    player_last_name,
    team,
    points,
    rebounds,
    assists,
    steals,
    blocks,
    turnovers,
    minutes_played
from {{ ref('stg_player_game_stats') }}
