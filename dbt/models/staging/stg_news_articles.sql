-- Silver staging model: parses/types one row per news article out of the
-- Bronze `raw_pulls` JSONB payloads for source='public_feed',
-- endpoint='news' (docs/superpowers/specs/2026-09-07-nba-news-feed-design.md),
-- and de-duplicates to the most-recently-pulled version of each article.
--
-- Real payload shape (verified directly against a live response,
-- 2026-09-07 -- see the design spec's Findings section, NOT an assumption
-- like most other staging models' header comments):
-- {
--   "header": "NBA News",
--   "articles": [
--     {
--       "id": 49824980,
--       "type": "Story",
--       "headline": "...",
--       "description": "...",
--       "byline": "Marc J. Spears",
--       "published": "2026-09-06T18:30:00Z",
--       "lastModified": "2026-09-06T18:30:00Z",
--       "links": {"web": {"href": "https://www.espn.com/nba/story/..."}}
--     }
--   ]
-- }
--
-- Dedup here differs from every other staging model's rationale (spec's
-- "Article identity & dedup" section): a game/box-score row is the same
-- entity re-pulled with updated values each poll, but a news article
-- mostly just RECURS unchanged across polls until it either gets
-- corrected in place (same `id`, new `lastModified`) or ages out of
-- ESPN's rolling window. The "keep latest pulled_at per id" pattern still
-- holds -- it just needs the real per-article `id`, not a derived key.

with raw_news_pulls as (

    select
        id as raw_pull_id,
        payload,
        pulled_at
    from {{ source('raw', 'raw_pulls') }}
    where source = 'public_feed'
      and endpoint = 'news'
      -- raw_pulls is append-only and grows forever; a rolling live feed
      -- only ever needs a recent window of pulls to reconstruct current
      -- state -- bounding this avoids an unbounded full-table scan on
      -- every dbt run (review punch list: "Unbounded growth").
      and pulled_at >= current_timestamp - interval '7 days'

),

-- One `raw_pulls` row holds a whole `{"articles": [...]}` batch -> explode
-- it so downstream CTEs operate one row per article.
exploded as (

    select
        article_json,
        raw_pull_id,
        pulled_at
    from raw_news_pulls
    cross join lateral jsonb_array_elements(payload -> 'articles') as article_json
    -- ESPN's feed can carry content types other than a written story
    -- (e.g. galleries, videos) whose `id` namespace isn't guaranteed
    -- disjoint from a Story's -- filtering to Story guards the dedup key
    -- below rather than trusting `id` alone across types (review punch
    -- list: "id/type collision").
    where article_json ->> 'type' = 'Story'

),

typed as (

    select
        (article_json ->> 'id')::bigint as article_id,
        article_json ->> 'headline' as headline,
        article_json ->> 'description' as summary,
        article_json ->> 'byline' as byline,
        (article_json ->> 'published')::timestamptz as published_at,
        article_json -> 'links' -> 'web' ->> 'href' as article_url,
        -- Hardcoded, not read off the payload -- this mart has exactly one
        -- source today. Reserving the column now means a real Phase 2
        -- source (Instagram) can arrive as an additive UNION ALL later,
        -- matching games.sql's own multi-source posture, rather than a
        -- breaking migration of this table plus its API/tool consumers
        -- (review punch list: "no source discriminator column").
        'public_feed' as source,
        raw_pull_id,
        pulled_at
    from exploded

),

deduped as (

    select
        *,
        row_number() over (
            partition by article_id
            -- `raw_pull_id` (the Bronze surrogate key, monotonically
            -- increasing) is the tiebreaker for two rows sharing the same
            -- `article_id` AND the same `pulled_at` -- e.g. two distinct
            -- `raw_pulls` rows written in the same instant (review punch
            -- list: "duplicate (id, pulled_at) pair"). The later-inserted
            -- row wins deterministically rather than depending on
            -- undefined row order.
            order by pulled_at desc, raw_pull_id desc
        ) as rn
    from typed

)

select
    article_id,
    headline,
    summary,
    byline,
    published_at,
    article_url,
    source,
    pulled_at as ingested_at
from deduped
where rn = 1
