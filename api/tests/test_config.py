from api.core.config import Settings


def test_runtime_database_url_prefers_api_reader_dsn(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://admin:admin@localhost:5432/nba")
    monkeypatch.setenv(
        "API_DATABASE_URL",
        "postgresql://api_reader:api_reader_pw@localhost:5432/nba",
    )

    settings = Settings()

    assert (
        settings.runtime_database_url
        == "postgresql://api_reader:api_reader_pw@localhost:5432/nba"
    )


def test_runtime_database_url_falls_back_to_admin_dsn(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://admin:admin@localhost:5432/nba")
    monkeypatch.delenv("API_DATABASE_URL", raising=False)

    # `_env_file=None` disables pydantic-settings' `.env` file source for this
    # instance only — see ingestion/tests/test_config.py for the full
    # rationale (a real api/.env on disk would otherwise still supply the
    # value this test needs absent, since env-file values are a separate
    # config source from `os.environ`).
    settings = Settings(_env_file=None)

    assert settings.api_database_url == ""
    assert settings.runtime_database_url == "postgresql://admin:admin@localhost:5432/nba"
