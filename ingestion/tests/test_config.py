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

    settings = Settings()

    assert settings.ingestion_database_url == ""
    assert settings.runtime_database_url == "postgresql://admin:admin@localhost:5432/nba"
