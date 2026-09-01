from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://nba:nba@localhost:5432/nba"
    ingestion_database_url: str = ""
    balldontlie_api_key: str = ""
    # docs/prd.md §03: ESPN's unauthenticated public scoreboard feed (assumed
    # shape, same caveat as ingestion/sources/public_feed.py).
    public_feed_base_url: str = (
        "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"
    )

    @property
    def runtime_database_url(self) -> str:
        """Connection string ingestion code should actually use.

        Prefers the least-privilege `ingestion_writer` DSN
        (`ingestion_database_url`) once the db-foundations role migrations
        have been applied, falling back to the admin `database_url` for
        local dev before that.
        """
        return self.ingestion_database_url or self.database_url
