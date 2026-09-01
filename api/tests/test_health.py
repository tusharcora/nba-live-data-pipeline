from fastapi.testclient import TestClient

from api.main import app

client = TestClient(app)


def test_health_is_public():
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_games_requires_api_key():
    resp = client.get("/games/")
    assert resp.status_code == 401
