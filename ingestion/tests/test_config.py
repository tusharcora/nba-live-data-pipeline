from ingestion.config import Settings


def test_runtime_database_url_prefers_ingestion_writer_dsn(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://admin:admin@localhost:5432/nba")
    monkeypatch.setenv(
        "INGESTION_DATABASE_URL",
        "postgresql://ingestion_writer:ingestion_writer_pw@localhost:5432/nba",
    )

    settings = Settings()

    assert (
        settings.runtime_database_url
        == "postgresql://ingestion_writer:ingestion_writer_pw@localhost:5432/nba"
    )


def test_runtime_database_url_falls_back_to_admin_dsn(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://admin:admin@localhost:5432/nba")
    monkeypatch.delenv("INGESTION_DATABASE_URL", raising=False)

    # `_env_file=None` disables pydantic-settings' `.env` file source for this
    # instance only — `monkeypatch.delenv` alone only clears the process
    # environment, so a real `ingestion/.env` on disk (as a developer running
    # this locally will have) would otherwise still supply the value this
    # test needs absent, since env-file values are a separate config source
    # from `os.environ`. Env vars set via `monkeypatch.setenv` above still
    # apply normally; only file-based loading is turned off.
    settings = Settings(_env_file=None)

    assert settings.ingestion_database_url == ""
    assert settings.runtime_database_url == "postgresql://admin:admin@localhost:5432/nba"
