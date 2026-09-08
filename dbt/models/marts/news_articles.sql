-- Gold `news_articles` table (Phase 1 of
-- docs/superpowers/specs/2026-09-07-nba-news-feed-design.md): general NBA
-- news, ESPN-sourced. Straight passthrough of stg_news_articles' dedup,
-- same posture as stg_games.sql's own header comment ("mart layer is a
-- straight passthrough ... for now") -- only one source feeds this mart
-- today, so there is nothing to union or reconcile yet.
--
-- Filters out any article missing its link-out URL: the link-out is a
-- stated Goal in the design spec, so an article that can't satisfy it
-- isn't servable (review punch list: "missing links.web.href").
--
-- Carries `source` through (see stg_news_articles.sql) so a future Phase 2
-- source can UNION ALL onto this mart additively, same posture as
-- games.sql (review punch list: "no source discriminator column").

select
    article_id,
    headline,
    summary,
    byline,
    published_at,
    article_url,
    source,
    ingested_at
from {{ ref('stg_news_articles') }}
where article_url is not null
