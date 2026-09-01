from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://nba:nba@localhost:5432/nba"
    api_database_url: str = ""
    redis_url: str = ""
    api_service_key: str = ""

    @property
    def runtime_database_url(self) -> str:
        """Connection string API code should actually use.

        Prefers the least-privilege `api_reader` DSN (`api_database_url`)
        once the db-foundations role migrations have been applied, falling
        back to the admin `database_url` for local dev before that.
        """
        return self.api_database_url or self.database_url
