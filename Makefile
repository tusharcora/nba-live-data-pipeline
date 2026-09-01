.PHONY: up down ps logs migrate test-db test-ingestion test-api test-quality test-all api-dev web-dev dbt-run dbt-parse

# `PYTHONPATH=src[:../db/src]` is a defensive belt-and-suspenders measure, not
# strictly required when uv's own editable-install .pth files are working.
# On some machines (observed with iCloud Drive's "Desktop & Documents
# Folders" sync enabled on a project living under ~/Documents), those .pth
# files intermittently get macOS's hidden flag reapplied by something
# outside uv's control, which makes `import db`/`import ingestion`/etc. fail
# with ModuleNotFoundError even though the venv is otherwise fine. Setting
# PYTHONPATH explicitly bypasses that fragile file-based mechanism entirely.
DB_SRC := $(CURDIR)/db/src

up:
	docker compose up -d

down:
	docker compose down

ps:
	docker compose ps

logs:
	docker compose logs -f

migrate:
	cd db && PYTHONPATH=src uv run alembic upgrade head

test-db:
	cd db && PYTHONPATH=src uv run pytest -v

test-ingestion:
	cd ingestion && PYTHONPATH=src:$(DB_SRC) uv run pytest -v

test-api:
	cd api && PYTHONPATH=src:$(DB_SRC) uv run pytest -v

test-quality:
	cd quality && PYTHONPATH=src:$(DB_SRC) uv run pytest -v

test-all: test-db test-ingestion test-api test-quality

api-dev:
	cd api && PYTHONPATH=src:$(DB_SRC) uv run uvicorn api.main:app --reload --port 8000

web-dev:
	cd web && npm run dev

dbt-run:
	cd dbt && uv run dbt run

dbt-parse:
	cd dbt && uv run dbt parse --no-partial-parse
