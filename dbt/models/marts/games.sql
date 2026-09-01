-- Placeholder Gold model. Real version is the reconciled `games` table
-- (docs/prd.md §06) that the API and prediction model both read from.
select *
from {{ ref('stg_games') }}
