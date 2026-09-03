-- Silver staging model: parses nba_api's (stats.nba.com) box-score
-- payload out of the Bronze `raw_pulls` table into one row per
-- player/game box-score stat line, matching stg_player_game_stats's
-- (the balldontlie sibling) column contract so the two can be UNIONed by
-- `player_game_stats.sql` (docs/prd.md §04, §06).
--
-- Source: Employee 1's merged `backfill_nba_stats_flow`
-- (`ingestion/src/ingestion/flows/backfill_nba_stats_flow.py`) /
-- `NBAStatsClient.get_boxscore` (`ingestion/src/ingestion/sources/
-- nba_stats.py`), read directly on this branch to confirm the shape below
-- (not re-derived from the boss's plan text alone). NBA.com and
-- balldontlie use different game-ID spaces; the flow already resolves
-- this at ingestion time by matching NBA.com's games onto balldontlie's
-- Gold `games` table by team-name overlap, so this model does zero
-- cross-source matching -- `balldontlie_game_id` is a direct, already-
-- resolved passthrough.
--
-- Payload shape (source='nba_stats', endpoint='boxscore_traditional'):
-- {
--   "balldontlie_game_id": 15908,
--   "player_stats": [
--     {
--       "GAME_ID": "0022300500", "TEAM_ID": 1610612737,
--       "TEAM_ABBREVIATION": "POR", "TEAM_CITY": "Portland",
--       "PLAYER_ID": 1629027, "PLAYER_NAME": "Gary Trent Jr.",
--       "START_POSITION": "G", "COMMENT": "", "MIN": "34:12",
--       "PTS": 20, "REB": 4, "AST": 3, "STL": 1, "BLK": 0, "TO": 2,
--       "PF": 2, "PLUS_MINUS": 5.0, ... (shooting splits, unused here),
--       "player_key": "gary trent jr."
--     }
--   ]
-- }
--
-- Note this is NOT a "data" array like balldontlie's shape -- the
-- top-level key is "player_stats", and `balldontlie_game_id` is a
-- *sibling* key at the payload root, not nested per-player. We explode
-- `player_stats` and re-attach `balldontlie_game_id` from the payload
-- root to every exploded row.
--
-- ============================================================================
-- DECISION LOG (all four required by the boss's task spec)
-- ============================================================================
--
-- 1) stat_id (synthetic key) -- nba_api's PlayerStats rows carry no
--    standalone primary key the way balldontlie's `data[].id` is a real
--    id from their API. Before inventing one, grepped the repo for
--    `stat_id` usage outside the staging/mart models themselves:
--      - web/app/explorer/page.tsx: used only as a TS field type and a
--        React list `key={row.stat_id}` -- never joined against anything.
--      - api/src/api/routers/player_stats.py: used only to
--        `order_by(...stat_id.desc())` ("most recently loaded first") --
--        a display/ordering convenience, not a join key.
--      - api/tests/test_player_stats.py: asserts on stat_id values as
--        plain per-row identifiers/ordering, never a join.
--    No usage anywhere treats stat_id as a real foreign key/join target.
--    Conclusion: a synthetic, deterministic, per-row-unique key is safe --
--    and since nothing joins on it, it can stay a plain bigint rather than
--    a text key: `game_id * 10,000,000 + PLAYER_ID`. Unique per (game,
--    player) as long as PLAYER_ID stays under 10 million (true across
--    NBA.com's entire player-ID history to date) and stable across
--    re-pulls (de-dup by pull recency still works). This keeps `api`'s and
--    `web`'s existing `stat_id: number`/bigint assumptions valid with zero
--    changes there, avoiding the type-unification `UNION ALL` would
--    otherwise force in `player_game_stats.sql` if this were text.
--
-- 2) player_first_name / player_last_name (suffix-aware split) --
--    nba_api's PLAYER_NAME is a single "First Last" string (e.g. "Gary
--    Trent Jr."). Neither a first-space nor a last-space split alone is
--    safe for suffixed names. `ingestion.normalization.clean_display_name`
--    already solves this in Python (its `_SUFFIX_RE`:
--    `r"[,\s]*\b(?P<suffix>Jr|Sr|II|III|IV)\.?\s*$"`, case-insensitive),
--    but dbt can't call Python inline, so this mirrors the same
--    suffix-token list/shape directly in SQL (Postgres word-boundary
--    escape is `\y`, not `\b`):
--      - Detect a trailing suffix token via
--        `regexp_match(name, '\y(Jr|Sr|II|III|IV)\.?\s*$', 'i')`.
--      - Strip it (plus any leading comma/whitespace) via
--        `regexp_replace(name, '[,\s]*\y(Jr|Sr|II|III|IV)\.?\s*$', '', 'i')`
--        to get a suffix-free "base name".
--      - Split the base name on its *last* space
--        (`regexp_match(base, '^(.*)\s+(\S+)$')`) into first/last, then
--        re-append the canonicalized suffix to the last name when one was
--        found.
--    Worked examples (also exercised by the unit test in
--    stg_player_game_stats_nba.yml):
--      "Gary Trent Jr."  -> suffix "Jr" found -> base "Gary Trent"
--                         -> first "Gary", last "Trent" + " Jr." = "Trent Jr."
--      "Stephen Curry"   -> no suffix -> base "Stephen Curry"
--                         -> last-space split -> first "Stephen", last "Curry"
--      "Nene"            -> no suffix, no space in base -> first "Nene",
--                            last NULL (single-word edge case; documented,
--                            not fabricated).
--    Known limitation (not solved, documented not hidden): a genuine
--    multi-word first/middle name with no suffix (e.g. a hypothetical
--    "Metta World Peace") would mis-split ("Metta World" / "Peace") --
--    same class of limitation the last-space heuristic has in Python
--    callers too; not hit by any real current-roster name.
--
-- 3) player_key -- already present as a top-level key in each
--    player_stats[] row (computed once, in Python, by
--    `NBAStatsClient.get_boxscore` via `normalize_player_key`). No
--    computation needed here -- extracted directly via `->> 'player_key'`.
--
-- 4) minutes_played -- nba_api's `MIN` format was NOT confirmed with
--    certainty by Employee 1 (no live stats.nba.com call was possible in
--    either sandbox) -- community references disagree on whether it's a
--    bare numeric string or "MM:SS". This project has hit exactly this
--    "assumed shape wrong against real data" failure mode twice before
--    with balldontlie's own `/stats` `min` field (see
--    stg_player_game_stats.sql's header). Rather than guess a single
--    shape, this reuses that model's exact defensive dual-format parser
--    unchanged (bare-integer-string vs "MM:SS", null-safe otherwise),
--    applied to `player_row ->> 'MIN'`. Documented here, not asserted as
--    confirmed, for the same honesty reason.
--
-- team -- nba_api's PlayerStats rows carry `TEAM_CITY` and
-- `TEAM_ABBREVIATION`, but no single full-team-name column the way
-- balldontlie's `team.full_name` is (e.g. "Dallas Mavericks"). Of the two
-- available columns, `TEAM_ABBREVIATION` (e.g. "POR") is chosen over
-- `TEAM_CITY` (e.g. "Portland") because it's unambiguous across the two
-- same-city NBA markets (`TEAM_CITY` alone can't distinguish the Lakers
-- from the Clippers, both "Los Angeles"/"LA"-ish, whereas
-- `TEAM_ABBREVIATION` gives "LAL" vs "LAC"). This means the mart's `team`
-- column will show inconsistent formats across sources ("Dallas
-- Mavericks" for balldontlie rows vs "POR" for nba_stats rows) until a
-- follow-up either augments the Bronze payload with a real full team name
-- or standardizes downstream -- a deliberate, documented simplification,
-- not an oversight.

with raw_stat_pulls as (

    select
        id as pull_id,
        pulled_at,
        (payload ->> 'balldontlie_game_id')::bigint as game_id,
        jsonb_array_elements(payload -> 'player_stats') as player_row
    from {{ source('raw', 'raw_pulls') }}
    where source = 'nba_stats'
      and endpoint = 'boxscore_traditional'

),

name_parts as (

    select
        pull_id,
        pulled_at,
        game_id,
        player_row,
        player_row ->> 'PLAYER_NAME' as player_name_raw,
        -- Trailing suffix token (Jr/Sr/II/III/IV), case-insensitive,
        -- optional trailing period, anchored at the end of the string.
        -- Mirrors ingestion.normalization._SUFFIX_RE exactly (see header)
        -- so the two layers agree on what counts as a suffix. Postgres'
        -- word-boundary escape is `\y` (Python's `\b`).
        (regexp_match(player_row ->> 'PLAYER_NAME', '\y(Jr|Sr|II|III|IV)\.?\s*$', 'i'))[1] as suffix_token_raw,
        -- Suffix-free "base name": strips a trailing ", Jr."/" Jr."/" II"
        -- etc. (with any leading comma/whitespace) so the remainder can be
        -- first/last-name-split the same way as an un-suffixed name.
        trim(regexp_replace(player_row ->> 'PLAYER_NAME', '[,\s]*\y(Jr|Sr|II|III|IV)\.?\s*$', '', 'i')) as base_name

    from raw_stat_pulls

),

name_split as (

    select
        *,
        -- Splits base_name on its LAST space: group 1 = everything before
        -- it (first name, or first+middle for an unhandled multi-word
        -- first name -- see header's known limitation), group 2 = the
        -- final token (last name root). NULL for a single-word base_name
        -- (e.g. "Nene") -- handled explicitly below, not fabricated.
        regexp_match(base_name, '^(.*)\s+(\S+)$') as last_space_match
    from name_parts

),

typed as (

    select
        pull_id,
        game_id,
        -- Synthetic per-row key -- see header decision log (1). Safe
        -- because nothing in the codebase joins on stat_id (grep
        -- findings also in the header). Kept as a real bigint (not text)
        -- by encoding player_id into game_id's low 7 digits --
        -- balldontlie game_id is currently ~7 digits and NBA.com
        -- PLAYER_ID has never exceeded 7 digits across the league's
        -- history -- so this stays unique per (game, player), stable
        -- across re-pulls, and requires zero changes to api/'s or web/'s
        -- existing `stat_id: number`/bigint assumptions, unlike a text key.
        game_id * 10000000 + (player_row ->> 'PLAYER_ID')::bigint as stat_id,
        (player_row ->> 'PLAYER_ID')::bigint as player_id,
        coalesce(last_space_match[1], base_name) as player_first_name,
        case
            when suffix_token_raw is null then last_space_match[2]
            when last_space_match[2] is not null then
                last_space_match[2] || ' ' || (
                    case lower(suffix_token_raw)
                        when 'jr' then 'Jr.'
                        when 'sr' then 'Sr.'
                        when 'ii' then 'II'
                        when 'iii' then 'III'
                        when 'iv' then 'IV'
                    end
                )
            -- Degenerate case: base_name is a single word (e.g. the raw
            -- name was just a suffix token with nothing before it) --
            -- fall back to the canonical suffix alone rather than NULL.
            else
                case lower(suffix_token_raw)
                    when 'jr' then 'Jr.'
                    when 'sr' then 'Sr.'
                    when 'ii' then 'II'
                    when 'iii' then 'III'
                    when 'iv' then 'IV'
                end
        end as player_last_name,
        -- Already computed in Python and passed through Bronze unmodified
        -- -- see header decision log (3).
        player_row ->> 'player_key' as player_key,
        -- See header's "team" note: abbreviation chosen over city for
        -- unambiguousness; format will differ from balldontlie's full
        -- team names in the unioned mart.
        player_row ->> 'TEAM_ABBREVIATION' as team,
        (player_row ->> 'PTS')::int as points,
        (player_row ->> 'REB')::int as rebounds,
        (player_row ->> 'AST')::int as assists,
        (player_row ->> 'STL')::int as steals,
        (player_row ->> 'BLK')::int as blocks,
        -- nba_api names the turnovers column "TO", not "TURNOVER" --
        -- different from balldontlie's "turnover".
        (player_row ->> 'TO')::int as turnovers,
        -- Dual-format defensive parser, reused unchanged from
        -- stg_player_game_stats.sql's "min" handling -- see header
        -- decision log (4). Guards against null/empty/anything else so
        -- this never errors the model.
        case
            when nullif(trim(player_row ->> 'MIN'), '') is null then null
            when (player_row ->> 'MIN') ~ '^[0-9]+:[0-9]+$' then
                split_part(player_row ->> 'MIN', ':', 1)::numeric
                + split_part(player_row ->> 'MIN', ':', 2)::numeric / 60
            when (player_row ->> 'MIN') ~ '^[0-9]+$' then
                (player_row ->> 'MIN')::numeric
            else null
        end as minutes_played,
        pulled_at

    from name_split

),

deduped as (

    select
        typed.*,
        row_number() over (
            partition by stat_id
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
    player_key,
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
