# Week 2 Implementation Plan — Live Ingestion & the Quality Gate

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development — one fresh subagent ("employee") per task below, reviewed and merged by a "boss" subagent per team before human sign-off, exactly as executed for Week 1. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/prd.md` §12 Week 2: live polling against both data sources, and the three quality-gate mechanisms (schema fingerprinting, volumetric checks, statistical/PSI drift, cross-source reconciliation) that make `schema_change_log` and `quality_metrics` start filling with real signal.

**Architecture:** Two independent boss teams, both branching off `main` in parallel (no cross-team dependency this week — unlike Week 1, no new shared foundation blocks either team). `week2/live-ingestion` extends `ingestion/` with a second source client and a real `live_game_flow`, plus one new Bronze/Silver table (`live_game_state`). `week2/quality-gate` introduces a new top-level `quality/` package (same shared-library pattern as `db/`) implementing the four algorithms from `docs/prd.md` §07 against tables that already exist from Week 1 (`schema_change_log`, `quality_metrics`, `source_conflicts` — no new migration needed for this team). Every algorithm is designed pure-function-first (dict/list in, typed rows out) with DB/network access pushed to a thin DI seam at the edge, continuing Week 1's testable-without-live-infra pattern.

**Tech Stack:** Same as Week 1 (Prefect 3, SQLAlchemy 2 + Alembic, httpx, pytest) plus nothing new — PSI is implemented by hand (no new stats library dependency needed for a straightforward binned-histogram formula).

**Spec:** `docs/prd.md` §03 (data sources), §04 (architecture — the "Quality Gate" box), §06 (data model), §07 (quality & drift monitoring), §12 Week 2 bullets.

## Global Constraints

- No live Postgres or real network access in this sandbox (same as Week 1) — every employee verifies via mocked HTTP + in-memory fakes + offline `alembic upgrade head --sql`, never real I/O.
- `raw_pulls` stays append-only; no employee should ever `UPDATE`/`DELETE` a Bronze row.
- Reuse Week 1's DI pattern: Prefect flow parameters needing fakes must be `@runtime_checkable` `Protocol`s (bare `Protocol` crashes Prefect's schema builder at decoration time; concrete classes reject fakes via `isinstance`).
- Reuse Week 1's `db` package models verbatim — `RawPull`, `SchemaChangeLog`, `QualityMetric` (Python attr `metadata_json` → DB column `metadata`), `SourceConflict`, `BackfillCheckpoint` — no redefinition, only extension (one new model this week: `LiveGameState`).
- Employees push real branches and open real GitHub PRs into their boss's branch; bosses review, test, and squash-merge; **no boss merges into `main`** — that's the human sign-off gate, same as Week 1.
- Employee branch names use a hyphen after the boss name, never a nested slash (`week2/live-ingestion-public-feed-client`, not `.../live-ingestion/public-feed-client`) — git refs can't be both a leaf and a directory.

---

## Team A: `week2/live-ingestion` (2 employees)

Boss branch created off `main`, no shared pre-setup needed (each employee's files don't overlap).

### Employee A1: `public-feed-client`

**Files:** Modify `ingestion/src/ingestion/sources/public_feed.py`; Test: `ingestion/tests/test_public_feed.py`.

**Task:** Implement the second, unauthenticated data source (`docs/prd.md` §03) — assume ESPN's public scoreboard shape (`GET https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=YYYYMMDD`, response `{"events": [{"id": ..., "date": ..., "competitions": [{"competitors": [{"homeAway": "home"|"away", "team": {"displayName": ...}, "score": "..."}], "status": {"type": {"name": "STATUS_FINAL"|"STATUS_IN_PROGRESS"|...}}}]}]}`), flagged explicitly as an assumed/unverified shape exactly like Week 1's balldontlie models. Single GET per date, no pagination (ESPN's scoreboard returns everything for the date in one response) — no auth header needed. Mirror `BallDontLieClient`'s `_get`/raise-on-non-2xx pattern for consistency, but simpler (one method, `get_scoreboard(date: str) -> dict`, no cursor loop).

**Skills for this task:** superpowers:test-driven-development (write the mocked-response test before the implementation — this is a clean, small, pure-ish client method); superpowers:systematic-debugging if a test fails unexpectedly; superpowers:verification-before-completion before reporting done.

### Employee A2: `live-game-flow`

**Files:** Create `db/migrations/versions/<rev>_create_live_game_state_table.py`; Modify `db/src/db/models.py` (add `LiveGameState`), `db/tests/test_models.py`; Modify `ingestion/src/ingestion/flows/live_game_flow.py`; Test: `ingestion/tests/test_live_game_flow.py`.

**Task:**
1. Add `LiveGameState` to `db/src/db/models.py` (Silver, `docs/prd.md` §06 — 1 row per poll per game while a game is live): `id` (pk), `game_id` (bigint, not null), `source` (str, not null — which source this poll snapshot came from), `pulled_at` (timestamptz, not null, server default now), `home_score` (int, nullable), `away_score` (int, nullable), `period` (int, nullable), `clock` (str, nullable — e.g. `"5:42"` or a status string), `status` (str, not null). Index on `(game_id, pulled_at)`.
2. Hand-write the Alembic migration (`op.create_table` + a real `downgrade()`, following the exact style of the three existing migrations in `db/migrations/versions/`) plus a `GRANT INSERT, SELECT ON live_game_state TO ingestion_writer;` (+ sequence grant) in the same migration, extending the least-privilege role from Week 1's `db-foundations` work — read that migration first to match its `DO $$ ... $$` idempotency-guard style if you re-touch role logic, though here you're only adding grants to an existing role, not recreating it.
3. Implement `live_game_flow` as **one poll cycle** (production scheduling/looping is out of scope this week — Prefect deployment scheduling is an ops concern, not flow logic): given a date, call both `BallDontLieClient.get_games_pages(date)` (reuse from `sources/balldontlie.py`, already implements pagination) and `PublicFeedClient.get_scoreboard(date)` (from Employee A1's PR — if that PR hasn't merged into your boss branch yet when you start, stub a minimal `get_scoreboard` call signature matching what's described above and note the dependency in your PR; don't block waiting), write a `RawPull` for each source's response (reuse `RawPullSink`/`SQLAlchemyRawPullSink` from `ingestion.flows.backfill_flow` rather than redefining), extract a `LiveGameState` row per game from each source's payload and write it via a similarly-shaped sink (design one generic `RowSink` protocol usable for `RawPull`/`LiveGameState`/`QualityMetric` alike if that's cleaner than three near-identical classes — your call, but don't triplicate the same 4-line class), and record a freshness metric: `QualityMetric(check_name="live_poll_lag_seconds", metric_value=<seconds between poll start and now>, metadata_json={"date": date})`.
4. Tests: fakes for both source clients and all sinks (no DB/network), verifying: both sources' raw pages get written, `LiveGameState` rows are extracted correctly from each source's shape, and a `live_poll_lag_seconds` metric is always written exactly once per invocation.

**Skills for this task:** superpowers:test-driven-development for the extraction/DI logic; superpowers:systematic-debugging (this is the most structurally complex piece this week — two sources, three sinks, a new migration — debug methodically if something doesn't compose); superpowers:verification-before-completion.

---

## Team B: `week2/quality-gate` (4 employees, new shared `quality/` package)

Boss branch created off `main`. **Before spawning employees**, the orchestrator pre-scaffolds the shared `quality/` package on this branch (mirrors how Week 1 pre-added dbt's `_sources.yml`) — a `uv init --package` skeleton with `sqlalchemy`, `psycopg[binary]`, `pydantic-settings` deps, an editable path dependency on `db` (same `uv.sources` pattern as `ingestion/pyproject.toml`), and a `config.py` — so no employee independently runs `uv init` and collides with a sibling. Each employee then owns exactly one new module + its test file inside the pre-built package; zero file overlap between the four.

### Employee B1: `schema-fingerprinting`

**Files:** Create `quality/src/quality/fingerprint.py`, `quality/tests/test_fingerprint.py`.

**Task:** Implement schema drift detection (`docs/prd.md` §07 "Schema drift"):
- `fingerprint_payload(payload: dict) -> dict[str, str]` — pure function: flattens a JSON payload into `{dot.path: type_name}` (e.g. `{"data.0.id": "int", "data.0.home_team.full_name": "str"}`) using the first element of any list found (payloads here are always `{"data": [...], "meta": {...}}`-shaped per Week 1's ingestion) as the representative record shape; skip `None`-valued fields (JSON nulls carry no type information) rather than fingerprinting them as `"NoneType"`.
- `diff_fingerprints(source: str, endpoint: str, old: dict[str, str], new: dict[str, str]) -> list[SchemaChangeLog]` — pure function: fields in `new` not in `old` → one `SchemaChangeLog(change_type="added", new_type=...)` row each; fields in `old` not in `new` → `change_type="removed"`; fields in both with a different type string → `change_type="type_changed"` with both `old_type`/`new_type` set. No changes → empty list.
- An orchestration function `check_schema_drift(source: str, endpoint: str, current_payload: dict, lookup: PriorPayloadLookup, sink: SchemaChangeSink) -> list[SchemaChangeLog]` that fetches the previous `raw_pulls` payload for the same `(source, endpoint)` (via the injected `PriorPayloadLookup` protocol — production impl queries `raw_pulls` for the most recent row before the current one's `pulled_at`), fingerprints both, diffs, writes any changes via `sink`, and returns them. First-ever pull for a `(source, endpoint)` pair (no prior payload) → no changes, not an error.

**Skills for this task:** superpowers:test-driven-development (this module is almost entirely pure functions — ideal TDD material, write the diff-logic tests first with plain dicts, no mocking needed for the pure-function tests); superpowers:verification-before-completion.

### Employee B2: `volumetric-checks`

**Files:** Create `quality/src/quality/volumetric.py`, `quality/tests/test_volumetric.py`.

**Task:** Implement volumetric checks (`docs/prd.md` §07 "Volumetric checks" — "each completed game should produce exactly two teams and a bounded, non-zero range of player rows"):
- `check_game_volumetrics(game_id: int, team_ids: set[int], player_row_count_by_team: dict[int, int], min_players_per_team: int = 8, max_players_per_team: int = 15) -> QualityMetric` — pure function: fails (metric_value `0.0`) if `len(team_ids) != 2`, or if any team's player count falls outside `[min_players_per_team, max_players_per_team]`; passes (`1.0`) otherwise. Always returns one `QualityMetric(check_name="volumetric_game_check", metadata_json={"game_id": ..., "team_ids": ..., "player_counts": ..., "failure_reason": ... or None})` — the metadata must explain *why* it failed when it fails, not just that it did.
- An orchestration function `check_completed_games(reader: GoldReader, sink: QualityMetricSink, as_of: date) -> list[QualityMetric]` — `GoldReader` is a DI protocol with a method like `get_completed_games_with_player_counts(as_of: date) -> list[tuple[int, set[int], dict[int, int]]]` (production impl runs a read-only SQLAlchemy Core query against the `games`/`player_game_stats` Gold tables dbt built in Week 1 — reflect them with `sqlalchemy.Table(..., autoload_with=engine)` rather than adding new ORM models for tables `quality` doesn't own). Runs the pure check per game, writes results via `sink`.

**Skills for this task:** superpowers:test-driven-development (the pure check function has clean boundary-value test cases — exactly 2 teams vs 1 vs 3, player count at/below/above the bounds — write those table-driven tests first); superpowers:verification-before-completion.

### Employee B3: `psi-drift`

**Files:** Create `quality/src/quality/drift.py`, `quality/tests/test_drift.py`.

**Task:** Implement Population Stability Index drift detection (`docs/prd.md` §07 "Statistical drift"):
- `compute_psi(reference: list[float], current: list[float], bins: int = 10) -> float` — pure function, standard PSI: derive `bins` bin edges from the **reference** distribution's quantiles (so bins have roughly equal reference-population share), compute each distribution's fraction of points per bin, then `psi = sum((current_pct - reference_pct) * ln(current_pct / reference_pct))` over bins, with a small epsilon (e.g. `1e-4`) floor on any zero bucket percentage to avoid `log(0)`/division-by-zero. Handle degenerate inputs (empty lists, all-identical values) without raising — return `0.0` for "no observable drift" when there's insufficient data to bin meaningfully, and document that choice in a comment.
- `check_field_drift(field_name: str, reference_values: list[float], current_values: list[float]) -> QualityMetric` — wraps `compute_psi`, returns `QualityMetric(check_name=f"psi_{field_name}", metric_value=<psi score>, metadata_json={"reference_n": len(reference_values), "current_n": len(current_values)})`.
- An orchestration function `check_weekly_drift(field_name: str, reader: NumericSeriesReader, sink: QualityMetricSink, as_of: date) -> QualityMetric` — `NumericSeriesReader` is a DI protocol (`get_values(field_name: str, start: date, end: date) -> list[float]`, production impl queries the Gold `player_game_stats` table for the named numeric column) fetching the trailing 7-14 days as "reference" and the most recent 7 days as "current" (exact window boundaries are your call — document the choice), runs the check, writes via `sink`.
- **Verify `compute_psi` numerically**, not just "it runs": test that two identical distributions produce `psi ≈ 0`, and that an obviously-shifted distribution (e.g. reference clustered around 10, current clustered around 25) produces a PSI clearly above a common industry rule-of-thumb threshold (~0.1 = moderate shift, ~0.25 = major shift) — assert against those thresholds, not just "> 0".

**Skills for this task:** superpowers:test-driven-development (write the "identical distributions → ~0" and "shifted distributions → large PSI" tests before the implementation, since they define correctness); superpowers:systematic-debugging (binning/log-of-zero edge cases are exactly the kind of subtle numerical bug that needs methodical isolation, not guessing); superpowers:verification-before-completion.

### Employee B4: `cross-source-reconciliation`

**Files:** Create `quality/src/quality/reconciliation.py`, `quality/tests/test_reconciliation.py`.

**Task:** Implement cross-source reconciliation (`docs/prd.md` §07 "Cross-source reconciliation" — "primary source wins unless a third check... corroborates the secondary"; for Week 2 scope, implement only the "primary source wins" rule and explicitly flag the corroboration refinement as future work, don't over-build it):
- `reconcile_game(game_id: str, primary_source: str, primary_fields: dict[str, str], secondary_source: str, secondary_fields: dict[str, str]) -> tuple[list[SourceConflict], float]` — pure function: for each field present in both `primary_fields` and `secondary_fields`, compare values (as strings — both dicts are pre-extracted `{field_name: str(value)}` maps so this function doesn't need to know either source's raw shape); where they differ, emit one `SourceConflict(field_name=..., primary_value=..., secondary_value=..., resolution=primary_fields[field_name])` row; return the conflict list plus the agreement rate (`(compared_fields - conflicts) / compared_fields`, or `1.0` if zero fields were comparable — document that edge case). Fields present in only one source are not conflicts (nothing to compare) and are not counted in the agreement-rate denominator.
- An orchestration function `reconcile_games_for_date(as_of: date, reader: DualSourceReader, sink: ReconciliationSink, primary_source: str = "balldontlie") -> QualityMetric` — `DualSourceReader` is a DI protocol returning, for a date, a list of `(game_id, primary_fields, secondary_fields)` tuples for games that both sources cover (matching games across sources by date + team names is a real, unsolved problem this week — implement a simple heuristic — e.g. same date and both team display-name sets overlap — and flag prominently in your PR that this matching heuristic needs validation/refinement once real data from both sources exists; don't try to solve NBA entity resolution perfectly here). Runs `reconcile_game` per matched pair, writes all conflicts via `sink`, and returns one aggregate `QualityMetric(check_name="cross_source_agreement_rate", metric_value=<overall agreement rate across all games>, metadata_json={"games_compared": ..., "date": ...})`.

**Skills for this task:** superpowers:test-driven-development (the pure `reconcile_game` function is straightforward table-driven-test material — matching fields, one conflicting field, a field present only on one side); superpowers:verification-before-completion.

---

## Verification (both bosses, before reporting to the human)

Same bar as Week 1 — nothing here can touch a live Postgres, so:
- `db`: `uv run pytest -v` (existing tests + any new `LiveGameState` structural test) and `uv run alembic upgrade head --sql` (offline; confirm the new migration chains after `a02795c40cbe` and the emitted `GRANT` targets the right table).
- `ingestion`: `uv run pytest -v` (existing + new `public_feed`/`live_game_flow` tests).
- `quality`: `uv run pytest -v` (all four modules' tests).
- Boss B additionally confirms there's exactly one `quality/pyproject.toml`/`uv.lock` (proof the pre-scaffold prevented a duplicate-package collision) and that all four employees' modules import cleanly together (`uv run python -c "from quality import fingerprint, volumetric, drift, reconciliation"`).

## Execution Handoff

Both boss branches are created and their teams dispatched in parallel immediately after this plan is saved (no separate approval checkpoint before dispatch — matches how Week 1 proceeded once the pattern was established). The human sign-off gate is, as before, the final merge into `main`.
