# Security Audit — Week 4, Injection & Auth-Bypass Pass

**Date:** 2026-09-02
**Scope:** `api/` (the FastAPI serving layer — `/games`, `/quality`, `/live`)
and `db/` (the `AuditLog` schema addition it depends on for future
manual-override tracking).
**Author:** Employee A2, `week4/security` team ("injection-audit-and-audit-log")
**Reference:** `docs/prd.md` §08 ("Security & hardening"), specifically the
"Definition of done" line: *"a manual pass attempting SQL injection and auth
bypass against every route. Document the pass in the write-up."* This is
that write-up.

This was a manual adversarial review, encoded as a suite of automated,
table-driven tests (`api/tests/test_security_audit.py`, 27 test cases) that
actually exercise every route through FastAPI's `TestClient` — not a
read-through of the route code with the results asserted by inspection. No
live Postgres was used or needed; `app.dependency_overrides` swaps in fake
readers so the tests prove the *validation and auth layers* reject bad
input before it ever reaches a query, independent of whatever the database
would or wouldn't have done with it.

---

## 1. What was tested

### 1.1 SQL injection via `GET /games?date=`

`/games` is the only route in this codebase that takes user input through a
query parameter that could plausibly be interpreted as part of a query
(`/quality` and `/live` take no query params at all). The route parses
`?date=` with `date.fromisoformat()` and raises `HTTPException(400)` on any
`ValueError` before the parsed value is ever handed to a `GamesReader` (see
`api/src/api/routers/games.py`). The theory to test: does that validation
actually catch every shape of malicious input, or only the ones the
original author happened to think of?

Twelve payloads were run, spanning classic SQL injection idioms
(tautologies, stacked queries, UNION-based, comment-terminated,
timing-based) plus a couple of non-SQL adversarial shapes to confirm the
validation isn't accidentally SQL-specific:

```
2024-01-01' OR '1'='1
2024-01-01; DROP TABLE games;--
' UNION SELECT * FROM api_reader--
1' OR '1'='1' --
2024-01-01' AND SLEEP(5)--
2024-01-01/**/OR/**/1=1
'; DROP TABLE games; --
2024-01-01 OR 1=1
2024-01-01' ; SELECT pg_sleep(5); --
<script>alert(1)</script>
2024-01-01\x00               (embedded null byte)
../../etc/passwd             (path-traversal-shaped string)
```

**Result: pass, all 12.** Every payload returned `400 {"detail":"date must
be in YYYY-MM-DD format"}` — never a `200` (silently accepted as a filter)
and never a `500` (meaning it reached the DB layer unhandled). Critically,
the test asserts on more than the status code: a `_CountingGamesReader`
fake is injected in place of the real reader, and the test fails if
`list_games` was ever called with any of these payloads. That's the
difference between "the endpoint happened to return 400" and "the
malicious string never got anywhere near a query" — this codebase never
builds raw SQL from `date` in the first place (see §3, below, on why this
generalizes), but the point of this test is that the *rejection* is
provably happening at the validation boundary, not being rescued downstream
by luck or by SQLAlchemy's parameterization.

A companion test (`test_legitimate_date_still_works_after_injection_sweep`)
confirms a well-formed date (`2024-01-01`) still reaches the reader
correctly — ruling out a degenerate fixture that would 400 on literally
anything.

### 1.2 Auth bypass against every gated route

Every route except `/health` sits behind `require_api_key`
(`api/src/api/core/security.py`), which compares the `X-API-Key` header
against `Settings().api_service_key` with a plain `!=` and raises
`HTTPException(401)` on any mismatch. Four variants were run against each
of `/games/`, `/quality/`, and `/live/` (12 cases total):

| Variant | What it proves |
|---|---|
| Missing header entirely | The baseline case — already covered per-route by `test_health.py`, `test_quality.py`, `test_live.py` prior to this suite; repeated here so the full bypass matrix lives in one place |
| Empty-string header (`X-API-Key: ""`) | A client that sends the header but with no value doesn't get treated as "no header" and waved through by some falsy-check bug |
| Wrong value (`"totally-not-the-real-key"`) | The obvious case, but worth asserting explicitly rather than assuming |
| Correct key, wrong case | `require_api_key` does a literal string comparison, not a case-insensitive one — confirms that's actually true in practice, since a case-insensitive comparison would be a real (if minor) auth weakening |

**Result: pass, all 12.** Every combination returned `401`. A guard test
(`test_wrong_case_key_differs_from_configured_key`) confirms the dedicated
test API key isn't degenerate (all-digits/symbols), which would make the
wrong-case variant silently identical to the real key and turn that
parametrized case into a false pass.

### 1.3 API key leakage into responses

Six requests — three authorized (200, one per route) and three rejected
(401, using a wrong/missing/empty key) — were made and every response's
full body text and every header value were searched for the literal
configured API key string.

**Result: pass.** The key never appeared in any response body or header,
authorized or rejected. This matters most for the rejected case: a naive
`require_api_key` implementation that formats an error message like
`f"expected {settings.api_service_key}, got {x_api_key}"` would leak the
real key to anyone who sends a wrong one — this codebase's actual message
(`"invalid or missing API key"`) doesn't do that, and this test would catch
it if a future change reintroduced the pattern.

---

## 2. Results summary

| Check | Cases run | Result |
|---|---|---|
| SQL injection via `/games?date=` | 12 | All rejected with 400, reader never invoked |
| Auth bypass (missing/empty/wrong/wrong-case) × 3 routes | 12 | All rejected with 401 |
| API key leakage in response body/headers | 6 requests inspected | No leakage in any |
| **Total new adversarial tests** | **27** | **27/27 passing** |

Full suite after this pass: **45 tests in `api/`** (18 pre-existing + 27
new), **13 tests in `db/`** (11 pre-existing + 2 new for `AuditLog`) — all
passing, verified by running `uv run pytest -v` in both packages.

---

## 3. Why this generalizes beyond `/games`

`/quality` and `/live` take no query parameters at all, so there's no
injection surface to test there today — the SQL-injection section of this
audit is necessarily `/games`-only, not an oversight. More broadly, every
DB-reading code path in this codebase (`SQLAlchemyGamesReader`,
`SqlAlchemyQualityReader`, `SQLAlchemyLiveStateReader`) builds queries
exclusively through SQLAlchemy Core/ORM constructs (`select(...).where(...)`,
reflected `Table` objects, parameterized comparisons) — there is no
string-formatted or f-string-built SQL anywhere in `api/` or `db/`. That's
what actually makes SQL injection structurally unreachable here, independent
of the `date.fromisoformat()` check; the 12-payload sweep in §1.1 is
confirming that claim empirically for the one place user input flows into a
query predicate, not the only thing standing between this API and injection.

---

## 4. What's explicitly out of scope or deferred (not silently skipped)

Per §08's full threat table, several rows are **not** covered by this pass
and are called out here rather than left ambiguous:

- **TLS / transport interception** — a deployment-time concern (reverse
  proxy / hosting platform TLS termination), not something that exists or
  can be tested in local dev or this sandbox. Deferred to actual deployment
  configuration, not tested here, and not claimed as done.
- **CORS lockdown** — being implemented by a sibling employee
  (`week4/security-cors-and-dependency-scanning`) on `api/src/api/main.py`,
  explicitly out of this task's file scope per the Week 4 plan. Not tested
  in this pass.
- **`pip-audit`/`npm audit` dependency scanning** and **gitleaks
  secret-scanning in CI** — also the sibling employee's task. Not run here.
- **Rate limiting under abuse** — already has dedicated, passing coverage
  in `api/tests/test_rate_limit.py` (drives `/games/` past the 100/minute
  limit and confirms 429s), written prior to this pass. Not duplicated
  here, but it's part of the same §08 threat table ("unauthenticated
  scraping / cost abuse") and is genuinely covered elsewhere.
- **Least-privilege Postgres roles** (`ingestion_writer`, `api_reader`) —
  already implemented and migrated (`db/migrations/versions/
  c4fede563f2b_create_least_privilege_roles_ingestion_.py`), predating this
  week's work. Not re-audited here beyond the new `audit_log` grant (§5).
- **Injection via HTTP headers, cookies, or request bodies** — every route
  in this API is `GET`-only with no request body and no cookie-based
  state, so these aren't applicable attack surfaces today. Worth
  re-auditing if a future route adds a body or cookie dependency.
- **Live-infrastructure verification** (a real Postgres actually enforcing
  the `api_reader` grants under a live connection, a real browser actually
  respecting CORS) — this sandbox has no Docker/live Postgres, consistent
  with every prior week. The `alembic upgrade head --sql` / `downgrade
  --sql` offline dry-runs (§5) are the strongest verification available
  here; a human with live infra should confirm the grants behave as
  expected against a real database at least once.

---

## 5. `audit_log` table (schema addition, not yet a live feature)

Per §08 ("Audit log table for any manual write/override, with actor +
timestamp"), a new `AuditLog` model and migration
(`db/migrations/versions/78b1b0fab0ea_create_audit_log_table.py`, chained
after `43c7e59b942d`) were added:

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | integer (PK) | no | |
| `actor` | string | no | Free-text — no unified identity system exists across the pipeline's processes yet, so this isn't a foreign key |
| `action` | string | no | What was done |
| `detail` | JSONB | **yes** | Unstructured context (before/after values, a reason) — deliberately unmodeled until a real caller exists |
| `created_at` | timestamptz | no | `server_default now()` |

**Important caveat, stated plainly rather than glossed over:** no feature
in this codebase currently performs a manual write/override, so this table
has no real writer yet. The migration grants `INSERT, SELECT` on
`audit_log` to `ingestion_writer` — the more privileged of the two existing
Postgres roles — purely as a provisional placeholder, documented as such in
the migration's own comment. This is **not** a considered access-control
decision for the eventual manual-override feature; it's "don't block on a
decision that has no real requirements yet." Whoever builds the actual
override feature should revisit this grant and scope it to whatever role
that feature's writing process actually runs as, rather than inheriting
`ingestion_writer`'s broader Bronze/Meta write access by default.

Verified offline (no live Postgres, matching this repo's standard
verification pattern): `alembic upgrade head --sql` emits a clean
`CREATE TABLE audit_log (...)` followed by the two `GRANT` statements and
chains correctly onto the existing head; `alembic downgrade
head:43c7e59b942d --sql` reverses both grants and drops the table cleanly.
A structural test (`db/tests/test_models.py::test_audit_log_table`,
`test_audit_log_nullability`) locks in the column set and nullability so a
future change can't silently drift from this spec.

---

## 6. Recommendations / follow-ups

1. Once a manual-override feature is actually designed, revisit the
   `audit_log` grant (§5) with a real actor-identity model instead of the
   `ingestion_writer` placeholder.
2. This pass covers what's reachable today. `/games` is the only route
   with a query parameter; if a future route adds one (a search term, a
   team filter, a free-text field), it should get the same
   payload-sweep treatment before shipping, not be assumed safe by analogy.
3. `require_api_key`'s equality check is a plain string comparison, not a
   constant-time comparison (e.g. `hmac.compare_digest`). For a single
   shared service-to-service key held only in a server-side BFF environment
   (never a public multi-tenant credential), the timing-attack risk is low,
   but it's a one-line hardening (`hmac.compare_digest(x_api_key,
   settings.api_service_key)`) worth picking up opportunistically rather
   than treating as urgent.
4. Confirm, on real infrastructure, that the `api_reader`/`ingestion_writer`
   grants actually behave as intended against a live Postgres instance —
   everything in this pass that touches roles/grants was verified via
   `alembic ... --sql` output inspection only, per this sandbox's
   constraints.
