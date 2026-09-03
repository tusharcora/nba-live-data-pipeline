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
-- **stat_id type note:** balldontlie's `stg_player_game_stats.stat_id` is
-- a real bigint (their own API's primary key); nba_api rows have no such
-- id, so `stg_player_game_stats_nba.stat_id` is a synthetic *text* key
-- (see that model's header decision log). `UNION ALL` requires both sides
-- of a column to share a type, so balldontlie's side is cast to text here
-- — this only happens in this Gold mart, not in `stg_player_game_stats`
-- itself (which keeps its native bigint `stat_id` for its own tests/
-- lineage). Known follow-up, out of scope for this dbt-only change: `api/`
-- reflects this table's columns via SQLAlchemy autoload
-- (`api/src/api/routers/player_stats.py`), and `web/`'s TypeScript type
-- (`web/app/explorer/page.tsx`: `stat_id: number`) both assume a numeric
-- `stat_id` — neither is touched here, since both currently only ever see
-- balldontlie rows (empty in practice) and this task is dbt-only scope.

select
    stat_id::text as stat_id,
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
