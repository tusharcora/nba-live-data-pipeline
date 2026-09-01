from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql://nba:nba@localhost:5432/nba"
    quality_database_url: str = ""

    @property
    def runtime_database_url(self) -> str:
        return self.quality_database_url or self.database_url
