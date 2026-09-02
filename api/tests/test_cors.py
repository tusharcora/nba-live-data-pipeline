from fastapi.testclient import TestClient

from api.core.config import Settings
from api.main import app

client = TestClient(app)


def test_allowed_origin_gets_matching_cors_header():
    resp = client.get("/health", headers={"Origin": Settings().allowed_origin})

    assert resp.headers.get("access-control-allow-origin") == Settings().allowed_origin


def test_disallowed_origin_gets_no_cors_header():
    resp = client.get("/health", headers={"Origin": "https://evil.example.com"})

    assert "access-control-allow-origin" not in resp.headers
