-- Gold mart: `player_game_stats` (docs/prd.md §06) — 1 row per player/game
-- box-score line. UNION of both independent Bronze sources for player
-- box-score stats:
--   - balldontlie's `/stats` endpoint, via `stg_player_game_stats`
--     (realistically permanently empty right now — balldontlie's free
--     tier never returns real stat data; see
--     docs: "player_game_stats requires balldontlie's paid ALL-STAR tier").
--   - nba_api's (stats.nba.com) local-only historical backfill, via
--     `stg_player_game_stats_nba` — see that model's header for the full
--     payload-shape/decision write-up.
--
-- **Deliberate simplification, not an oversight:** no cross-source
-- dedup/priority logic ("prefer balldontlie if both exist for the same
-- game/player") is implemented. Since balldontlie's side is realistically
-- permanently empty on the current API plan, there's no real overlapping
-- case to handle yet — this is `UNION ALL`, not a reconciled/deduplicated
-- view. Revisit if/when balldontlie's paid tier (or another source) is
-- ever added for the same games nba_api already covers.
--
select
    stat_id,
    game_id,
    player_id,
    player_first_name,
    player_last_name,
    player_key,
    team,
    points,
    rebounds,
    assists,
    steals,
    blocks,
    turnovers,
    minutes_played
from {{ ref('stg_player_game_stats') }}

union all

select
    stat_id,
    game_id,
    player_id,
    player_first_name,
    player_last_name,
    player_key,
    team,
    points,
    rebounds,
    assists,
    steals,
    blocks,
    turnovers,
    minutes_played
from {{ ref('stg_player_game_stats_nba') }}
