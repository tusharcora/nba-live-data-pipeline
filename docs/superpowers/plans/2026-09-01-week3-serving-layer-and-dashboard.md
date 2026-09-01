# Week 3 Implementation Plan — Serving Layer & Next.js Dashboard v1

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development — one fresh specialized subagent ("employee") per task below, reviewed and merged by a "boss" subagent per team before human sign-off, exactly as executed for Weeks 1-2. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/prd.md` §12 Week 3: real FastAPI endpoints (`/games`, `/live`, `/quality`) with rate limiting from day one, the Next.js BFF wired to all three (including an SSE route for `/live`), and functional (not yet polished — that's Week 5) Live Board and Data Quality Scorecard pages.

**Architecture:** Two independent boss teams, both branching off `main` in parallel — no cross-team dependency at the code level (Team B's Next.js routes call Team A's FastAPI endpoints over HTTP at runtime, not at build/test time, since Team B's tests mock `fetchFromApi`/`fetch` rather than requiring a live FastAPI process). `week3/api-serving` replaces the three stub routers with real handlers reading from Gold (`games`), Silver (`live_game_state`), and Meta (`quality_metrics`/`schema_change_log`/`source_conflicts`) tables via SQLAlchemy Core reflection (same read-only-table-we-don't-own pattern `quality/volumetric.py` established in Week 2). `week3/web-bff` adds fetch-through and SSE-passthrough Next.js Route Handlers plus two client-rendered pages consuming them.

**Tech Stack:** FastAPI + `slowapi` (new dependency, rate limiting) + SQLAlchemy Core. Next.js App Router, `"use client"` components with `EventSource` for the live page — no new npm dependency needed.

**Spec:** `docs/prd.md` §04 (architecture — the SSE path), §06 (data model), §07 (quality scorecard shape), §08 (security — rate limiting), §11 (frontend, "functional, not yet fully polished" is this week's explicit bar — the full "fully furnished" checklist is Week 5), §12 Week 3 bullets, §13 (risks — the Vercel SSE gotchas).

## Global Constraints

- No live Postgres, no live network, **and no way to actually deploy to Vercel or run a browser** in this sandbox. Every employee verifies via mocked/fake DB reads (Python) or mocked `fetch` (TypeScript) and `tsc`/`eslint`/`pytest` — nothing here can be verified end-to-end against real infrastructure. Say so explicitly in every PR.
- Every FastAPI route (except `/health`) already sits behind `require_api_key` (`api/src/api/core/security.py`) — don't remove or bypass that.
- Reuse the read-only-table-we-don't-own pattern from `quality/src/quality/volumetric.py`: SQLAlchemy Core `Table(..., autoload_with=engine)` against dbt-owned Gold tables, never new ORM models for tables `api` doesn't own.
- The browser must never call FastAPI directly and must never see `API_SERVICE_KEY` — only `web/lib/fastapi-client.ts` (server-only) holds it. Any new BFF route must go through `fetchFromApi`, not raw `fetch` to FastAPI.
- SSE responses (both FastAPI's and the BFF's) must set `Cache-Control: no-cache` and disable buffering (`X-Accel-Buffering: no` on the BFF side) per `docs/prd.md` §13's documented Vercel gotcha — get this right in code even though it can't be verified against real Vercel here.
- Employee branch names use a hyphen after the boss name (`week3/api-serving-games-endpoint`, not a nested slash) — same git ref constraint as Weeks 1-2.

---

## Team A: `week3/api-serving` (3 employees, shared rate-limiting pre-scaffold)

Before spawning employees, the orchestrator adds `slowapi` as an `api/` dependency and pre-scaffolds `api/src/api/core/rate_limit.py` (a shared `Limiter` keyed by the validated `X-API-Key`, wired into `api/main.py` via `SlowAPIMiddleware` + the standard 429 exception handler) on the boss branch, so all three employees apply the same `@limiter.limit(...)` decorator to their own route instead of three different rate-limiting approaches colliding at merge time.

### Employee A1: `games-endpoint`

**Files:** Modify `api/src/api/routers/games.py`; Test: `api/tests/test_games.py`.

**Task:** Replace the stub with a real `GET /games` reading the dbt-owned Gold `games` table (`dbt/models/marts/games.sql` for the exact column names: `game_id`, `game_date`, `season`, `status`, `postseason`, `home_team`, `away_team`, `home_score`, `away_score`, `source_pulled_at`). Support an optional `?date=YYYY-MM-DD` query param filtering to that date; with no param, return the most recent N games (pick a sane default, e.g. 20, document it). Reflect the table via SQLAlchemy Core (`Table("games", metadata, autoload_with=engine)`) using `Settings().runtime_database_url` — don't add a new ORM model. Apply the shared rate limiter.

### Employee A2: `quality-endpoint`

**Files:** Modify `api/src/api/routers/quality.py`; Test: `api/tests/test_quality.py`.

**Task:** Replace the stub with a real `GET /quality` assembling the scorecard shape from `docs/prd.md` §07: the latest row per distinct `check_name` from `quality_metrics` (import the ORM model from `db.models` — `api` already depends on `db`? check `api/pyproject.toml`; if not, add the same editable-path dependency `ingestion`/`quality` use), the N most recent `schema_change_log` rows, and a summary of `source_conflicts` (e.g. count + most recent few). Return a shape a frontend can render directly (a `{ metrics: [...], schema_changes: [...], conflicts_summary: {...} }`-style object — your call on exact keys, document them in the PR since Team B's UI employee will consume this). Apply the shared rate limiter.

### Employee A3: `live-endpoint`

**Files:** Modify `api/src/api/routers/live.py`; Test: `api/tests/test_live.py`.

**Task:** Replace the stub with a real `GET /live` as a `fastapi.responses.StreamingResponse` (`media_type="text/event-stream"`, headers include `Cache-Control: no-cache`) that periodically (e.g. every 5s, make it configurable) queries `live_game_state` (Silver, via `db.models.LiveGameState`) for the latest row per `game_id`, formats each poll as an SSE `data: <json>\n\n` event, and keeps streaming until the client disconnects (use `request.is_disconnected()` in the loop) or a max-duration safety cutoff (e.g. 4 hours) is hit. Structure the polling-loop logic as a separately-testable async generator function taking an injected reader (not a hardcoded DB call), so tests can drive a few iterations with fakes and assert on the yielded SSE-formatted strings without an actual sleep loop or DB. Apply the shared rate limiter to the route (not to each poll iteration — one hit per connection).

---

## Team B: `week3/web-bff` (4 employees)

Boss branch created off `main`. No shared pre-setup needed — the four employees' files don't overlap.

### Employee B1: `bff-fetch-routes`

**Files:** Create `web/app/api/games/route.ts`, `web/app/api/quality/route.ts`; no new test framework exists yet in `web/` — verify via `tsc --noEmit`/`eslint` only, matching how `app/api/health/route.ts` was verified in Week 0 scaffolding.

**Task:** Two simple fetch-through Route Handlers mirroring `app/api/health/route.ts`'s exact pattern: `GET` calls `fetchFromApi("/games" + query string passthrough)` / `fetchFromApi("/quality")`, returns the JSON, 502s on failure. For `/api/games`, forward the `date` query param from the incoming request to FastAPI's `/games?date=...` if present.

### Employee B2: `bff-sse-live-route`

**Files:** Create `web/app/api/live/route.ts`.

**Task:** The Vercel-safe SSE re-streaming route per `docs/prd.md` §04/§13: `export const runtime = "nodejs"` (required — Vercel's Edge runtime doesn't support the streaming pattern needed here), fetch FastAPI's `/live` (via a raw `fetch` to `${FASTAPI_BASE_URL}/live` with the `X-API-Key` header — you'll need to read the same env vars `fastapi-client.ts` uses, but `fetchFromApi`'s `.json()` call doesn't fit a streaming body, so this route talks to FastAPI slightly differently than the fetch-through routes; keep the API key handling server-only exactly like `fetchFromApi` does, don't refactor that helper), and pipe the upstream response's body straight through as this route's own body in a `new Response(upstreamResponse.body, { headers: {...} })`. Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`. **This cannot be verified against real Vercel or a real browser in this sandbox** — verify only that the code follows the documented pattern and that `tsc`/`eslint` pass; say so explicitly in the PR, and note that the Week-3 "SSE spike against real Vercel" from `docs/prd.md` §12/§13 is a deployment-time verification step for the human, not something this PR can close out.

### Employee B3: `live-board-ui`

**Files:** Create `web/app/live/page.tsx` (and a small client component file if you split one out, e.g. `web/app/live/LiveBoard.tsx`).

**Task:** A `"use client"` page that opens an `EventSource("/api/live")` on mount, renders each game's score/clock/status as events arrive, and closes the connection on unmount. This is Week 3 scope — **functional, not polished** (`docs/prd.md` §11 explicitly defers the full "fully furnished" checklist — loading skeletons, full accessibility pass, mobile responsiveness — to Week 5). Still implement the three basic states plainly (a loading message before the first event arrives, a "no live games" message if an event arrives with an empty list, and a visible error message if the `EventSource` reports an error) — don't ship a page that just goes blank on any of those paths.

### Employee B4: `quality-scorecard-ui`

**Files:** Create `web/app/quality/page.tsx`.

**Task:** A page rendering the quality scorecard from `/api/quality` — read Employee A2's response shape from their PR (if not yet merged into your boss branch, write against the shape documented in the plan's Employee A2 section above and flag the dependency explicitly, don't block). Can be a server component doing a direct `fetch` at request time (simpler than the live page, no streaming needed) or client-fetched — your call. Render the metrics list, recent schema changes, and conflicts summary as plain (unstyled-is-fine-for-now) lists/tables. Same Week 3 scope note as B3: functional over polished, but still handle empty/error states visibly rather than blank.

---

## Verification (both bosses, before reporting to the human)

- `api`: `uv run pytest -v` (existing 4 + three new route test files). Also confirm `slowapi` actually rate-limits in a test (hit a route more than the configured limit in a tight loop within one test and assert a 429 eventually) — this is a case where testing without live infra is fully possible and should be done for real, not skipped.
- `web`: `npx tsc --noEmit && npm run lint` for both teams' new files. (There is no existing Python-style test suite in `web/` yet — don't introduce a new test framework mid-week just for this; type-checking + lint is the established bar here, per `CLAUDE.md`.)
- Boss B additionally confirms Employee B2's SSE route headers exactly match the plan's required set (`Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, `Connection: keep-alive`, correct `Content-Type`) by reading the code, not just running `tsc`.
- Both bosses explicitly flag in their final report everything that still needs real infrastructure (live Postgres, a real FastAPI process, and — new this week — an actual Vercel deployment) to confirm, since this week introduces the first genuinely un-verifiable-in-sandbox piece (SSE against real Vercel).

## Execution Handoff

Both boss branches are created and their teams dispatched in parallel immediately after this plan is saved, matching Weeks 1-2. The human sign-off gate remains the final merge into `main`. Two small pre-existing/unrelated fixes (the `psycopg2`→`psycopg3` DSN scheme from Week 2, already merged, and a newly-found `next typegen`-before-`tsc` CI fix for the long-standing `web-check` failure) are handled directly by the orchestrator outside the employee/boss process, same as the DSN fix was in Week 2 — these are one-line, zero-design-decision fixes, not tasks that benefit from the review ceremony.
