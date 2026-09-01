from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql://nba:nba@localhost:5432/nba"
    ingestion_database_url: str = ""
    balldontlie_api_key: str = ""

    @property
    def runtime_database_url(self) -> str:
        """Connection string ingestion code should actually use.

        Prefers the least-privilege `ingestion_writer` DSN
        (`ingestion_database_url`) once the db-foundations role migrations
        have been applied, falling back to the admin `database_url` for
        local dev before that.
        """
        return self.ingestion_database_url or self.database_url
