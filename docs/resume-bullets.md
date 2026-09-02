# Resume Bullets — Real Numbers Filled In

Per `docs/prd.md` §14 ("Resume narrative") and the Week 6 mandate to fill
in real numbers once built. `docs/prd.md` mirrors an external PRD artifact
and isn't edited locally (its own header says to re-sync from the artifact
if they disagree), so the filled-in version lives here instead.

**Ground rule:** every number below is something this project actually
measured (test counts, real load-test latency/failure numbers, a real
schema-drift run). Where the PRD's original template implied a metric that
was never actually measured against real production data — a dual-source
disagreement rate, weeks of live PSI drift history — the bullet is
rewritten to claim what was actually demonstrated instead of inventing a
number. See `docs/PROGRESS.md`'s Known Issues for exactly why each of
those is still open.

---

- Architected a two-source data reconciliation pipeline for NBA box
  scores (balldontlie API + a public live-scoreboard feed) through a
  Bronze/Silver/Gold medallion warehouse in Postgres, with field-level
  disagreement detection and logging (not silent overwrite) built and
  covered by dedicated tests — the reconciliation and match-by-team-overlap
  logic is exercised by 10 test cases in `quality/tests/test_reconciliation.py`,
  pending a live run against real overlapping data from both sources.

- Designed a schema-drift and statistical-drift monitoring system (PSI-based)
  for a data pipeline with two independently-maintained upstream sources;
  validated schema fingerprinting for real against 3 production API pulls
  from a real backfill, confirming zero false positives and genuine schema
  stability, with the full drift/fingerprinting/reconciliation logic covered
  by 54 unit tests (`quality/`) ahead of sustained live-data collection.

- Orchestrated batch and streaming ingestion with Prefect (2 resumable,
  independently-checkpointed backfill flows plus a live-polling flow),
  backed by a dbt-modeled medallion warehouse in Postgres (4 models,
  20 data tests), with CI-enforced data-quality and unit tests
  (215 tests across 4 Python services) gating every merge across 41 merged
  pull requests.

- Shipped a live-updating analytics dashboard (Next.js + FastAPI, real-time
  via server-sent events) with three pages — a Live Board, a Data Quality
  Scorecard, and a Historical Explorer with date-range and player search —
  browser-verified end-to-end (real theme toggle, real empty/loading/error
  states, real keyboard accessibility, zero client-visible API calls on the
  server-rendered page).

- Hardened the public API surface with key-based auth, per-caller rate
  limiting, least-privilege database roles (`ingestion_writer`/`api_reader`),
  and CI-enforced dependency/secret scanning (`pip-audit`, `npm audit`,
  `gitleaks`), validated with a manual SQL-injection/auth-bypass review
  (27 adversarial test cases, `docs/security-audit.md`) and a real load
  test that found and fixed a genuine rate-limiting bug under realistic
  concurrency — re-verified at 0 failures and p95 latency ≈ 23ms at 50
  concurrent simulated users, roughly 12x under the project's 300ms target
  (`docs/performance-loadtest.md`).

- Ran a boss/employee multi-agent development workflow across every build
  phase — each phase's work reviewed, tested, and merged via real GitHub
  pull requests (41 merged) before a human sign-off gate — as the process
  backbone for the entire build, including catching and fixing cross-team
  integration bugs (a frontend/API response-shape mismatch, an Alembic
  migration multi-head divergence, a CI permissions bug) that neither
  side's own tests could have caught alone.
