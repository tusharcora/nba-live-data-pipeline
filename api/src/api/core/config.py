from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql://nba:nba@localhost:5432/nba"
    redis_url: str = ""
    api_service_key: str = ""
