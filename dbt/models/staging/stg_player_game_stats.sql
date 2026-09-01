-- Silver staging model: parses balldontlie's /stats endpoint payload out of
-- the Bronze `raw_pulls` table into one row per player/game box-score line
-- (docs/prd.md §04, §06).
--
-- `raw_pulls` is append-only — the same stat-line `id` can appear in more
-- than one pull (a re-pull picking up a correction/update to an in-progress
-- or since-finalized game). We de-duplicate to the most-recently-pulled
-- version of each stat line via row_number() (Postgres has no QUALIFY).
--
-- ASSUMED payload shape (balldontlie v1 /stats), not yet verified against
-- real ingested data:
-- {
--   "data": [
--     {
--       "id": 890321, "min": "34:12", "pts": 28, "reb": 7, "ast": 9,
--       "stl": 1, "blk": 0, "turnover": 3,
--       "game": {"id": 15908, ...},
--       "player": {"id": 237, "first_name": "Luka", "last_name": "Dončić"},
--       "team": {"id": 7, "full_name": "Dallas Mavericks", ...}
--     }
--   ],
--   "meta": {...}
-- }

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
        -- "min" comes back as a "MM:SS" string (or null/'' when a player
        -- didn't play). Split on ':' and convert to decimal minutes, e.g.
        -- "34:12" -> 34 + 12/60 = 34.2. Guard against null/empty/malformed
        -- values so this never errors the model — it just returns null.
        case
            when nullif(trim(stat_line ->> 'min'), '') is null then null
            when (stat_line ->> 'min') !~ '^[0-9]+:[0-9]+$' then null
            else
                split_part(stat_line ->> 'min', ':', 1)::numeric
                + split_part(stat_line ->> 'min', ':', 2)::numeric / 60
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
