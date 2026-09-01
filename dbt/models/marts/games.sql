-- Gold `games` table (docs/prd.md §06): 1 row per game, reconciled final
-- scores/status/schedule, read by the API and (later) the prediction model.
--
-- For now this is a straight passthrough of stg_games's de-duplicated,
-- typed rows from the balldontlie source only. Reconciliation against the
-- second (public feed) source is out of scope for this PR — see
-- docs/prd.md §07 ("Cross-source reconciliation") and §12 week 2 — and will
-- add a `source_conflicts`-aware merge here later without changing this
-- table's grain or column names.

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
