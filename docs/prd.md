# Live Box Score Pipeline & Data Quality Observatory

PRD · v1 · Draft for review
Source of truth: [PRD artifact](https://claude.ai/code/artifact/1f4076ad-1c3c-403a-b3a5-d987db3f10d0) — this file is a plain-markdown transcription for offline/local reference. If the two ever disagree, the artifact wins; re-sync this file from it.

An end-to-end data engineering project built on NBA box score and live game
data — where the portfolio-differentiating work is the ingestion,
reconciliation, and drift monitoring, not the dashboard on top of it.

- **Owner:** Tushar
- **Target roles:** Data Engineering / Analytics / SWE / AI-ML
- **Timeline:** 6 weeks, part-time
- **Frontend:** Next.js/React (custom) via a BFF layer, on Vercel

## 1. Why this beats another app

Most portfolio projects — including two rejected directions, a fullstack CRUD
app and a RAG agent — demonstrate that you can build *on top of* clean data
or a hosted model. They don't demonstrate the part of the job that's
actually hard to fake: deciding what to do when two sources disagree about
the same event, noticing when an upstream API silently changes shape, and
building something that tells you your data is degrading before your
dashboard quietly starts lying to you.

The centerpiece isn't a chart — it's a **data quality scorecard that tracks
itself over weeks of real, messy sports data**: schema drift events,
null-rate trends, and a disagreement rate between two independent live data
sources for the same games.

## 2. Scope decision

**Recommendation:** Core = the pipeline + quality observatory (this is what
gets you hired). Stretch = a small live win-probability model in week 4-5,
built on top of the curated data — reuses the drift-tracking infra instead
of bolting on new tooling.

**PM re-scope note:** "Complete" now means secured endpoints, sub-30-second
live freshness, and a fully furnished dashboard UI — real scope on top of
the original 4 weeks. The plan adds two weeks (6 total) with security
hardening and UI/performance as their own named phases. If the timeline has
to stay at 4 weeks, cut the ML stretch goal first — security and UI bar are
not optional.

Two structural decisions fell out of "combine live streaming + historical
box scores":

- **One sport, two independent sources.** Pull the *same* NBA games from two
  independently-maintained sources (a paid box-score API and a free public
  JSON feed) — this is what produces real deduplication/reconciliation
  problems. A single source never disagrees with itself.
- **Sport: NBA.** High game volume (~1,230 regular-season games/season),
  well-covered by both a documented API and an undocumented-but-stable
  public feed, and stat definitions that genuinely shift over time
  (tracking-stat additions, position-code changes) — real schema drift, not
  synthetic.

## 3. Data sources

| Source | Role | Coverage | Cost / limits |
|---|---|---|---|
| **balldontlie API** | Primary — box scores, live game state, play-by-play, injuries, standings | 1946–present historical; realtime updates for in-progress games | Free: 5 req/min. ALL-STAR tier ($9.99/mo) recommended — 60 req/min needed for a live poller during game windows. |
| **Public live-scoreboard JSON feed** (e.g. ESPN's unauthenticated endpoint) | Secondary — reconciliation source for the same games | Live scores & basic box score fields only | Free, undocumented, no SLA — treat as unstable by design; this instability is itself a drift-monitoring test case. |

**Rejected:** SportRadar / Genius Sports (enterprise pricing, overkill for a
solo project). Official NBA Stats API as primary (frequently rate-limits and
blocks cloud IPs; fine as a future third source, risky as the backbone).

## 4. Architecture

A medallion layout: nothing gets cleaned before it's captured raw, so every
quality signal can be recomputed against history.

```
SOURCES                ORCHESTRATION        BRONZE                 SILVER/GOLD              SERVING
balldontlie API   ──┐                  ┌─► Raw landing       ┌─► dbt staging      ┌─► FastAPI
  (historical+live)  ├─► Prefect flows ─┤   (append-only JSON,│   (typed, deduped, │   (REST over Postgres)
Public live feed  ──┘   backfill_flow  │    Postgres,per-pull)│    reconciled)     │        │
  (reconciliation)      live_game_flow │        │             └─► dbt marts       │        ▼
                                        │        ▼                 (games,        │  Next.js API routes
                                        └─► Drift & dedup gate     player_game_    │  (BFF — auth, SSE
                                            (schema diff, PSI,      stats)         │   re-stream)
                                             dbt tests) ──────────────────────────►│        │
                                            writes quality_metrics                 │        ▼
                                                                                    │  Next.js app (Vercel)
                                            Prediction model (stretch, week 4) ◄────┘  (EventSource + fetch)
```

The SSE path: FastAPI emits live game-state events, the BFF re-streams them
to the browser over `EventSource` — nothing calls FastAPI directly from
client-side code.

**Raw/Bronze** is append-only and immutable — every API pull is stored as
its own timestamped record, never overwritten. This is what makes drift
detection possible at all. **Silver** is where dbt models parse, type, and
reconcile the two sources into one row per game/player. **Gold** is the
analytics-ready star schema the API and model both read from.

## 5. Component cross-checks

Every tool choice was checked against its neighbors, not picked in
isolation.

| Decision point | Chosen | Checked against | Why the choice holds |
|---|---|---|---|
| Warehouse | Postgres | Rejected: DuckDB | The live poller and FastAPI serving layer both need to write/read concurrently while games are in progress. DuckDB is single-writer — right for batch-only, wrong once "live" is in scope. |
| Quality tooling | dbt tests + custom Python quality gate | Rejected: Great Expectations / Soda | dbt tests already cover structural constraints inside the transform layer. A second framework for statistical drift checks would be overlapping work — simple enough to write directly against `quality_metrics`. |
| Orchestration | Prefect | Rejected: Dagster, Airflow | Dagster's asset-centric model fits large teams with many interdependent assets — ceremony this project doesn't have. Airflow's ops overhead is disproportionate for two flows. Prefect's Python-decorator flows keep local dev fast with a hosted run-history dashboard. |
| Frontend platform | Custom Next.js/React app | Rejected: Framer code components | Framer's code components run real React, but every interaction is still built inside a no-code site editor. Owning the stack gives full control over routing/state/streaming with no platform lock-in. |
| Live game state transport | SSE (FastAPI `StreamingResponse`, re-streamed by the BFF) | Rejected: interval polling (SWR/`setInterval`) | Polling doesn't use the freedom of owning a real backend. SSE is genuine push, a stronger technical showcase, cheaper on the freshness SLA. Verified against a real Vercel deployment in week 3 rather than assumed. |
| Reconciliation rule | Prefer primary source; log + surface disagreements | Rejected: silent overwrite / "last write wins" | Silently picking one source loses the signal. Every field-level disagreement gets written to `source_conflicts` with both values — that table *is* the deduplication-ambiguity story for the write-up. |

## 6. Data model

| Table | Layer | Grain | Purpose |
|---|---|---|---|
| `raw_pulls` | Bronze | 1 row / API response | Immutable JSON + pull timestamp + source + endpoint |
| `games` | Gold | 1 row / game | Reconciled final scores, status, schedule |
| `player_game_stats` | Gold | 1 row / player / game | Box score line reconciled across sources |
| `live_game_state` | Silver | 1 row / poll / game | Time-series score & clock state while a game is live |
| `schema_change_log` | Meta | 1 row / detected change | Field added/removed/type-changed per source per date |
| `quality_metrics` | Meta | 1 row / check / run | Null rate, row-count anomaly, PSI score, agreement rate over time |
| `source_conflicts` | Meta | 1 row / field disagreement | Both values, both sources, resolution applied |

## 7. Quality & drift monitoring — the differentiator

Illustrative scorecard shape (rendered from `quality_metrics`): cross-source
agreement (%), null rate per field, schema changes over a trailing window,
PSI per numeric field.

- **Schema drift:** every raw pull is fingerprinted (field names + types). A
  diff against the last-known fingerprint per source/endpoint writes to
  `schema_change_log` and fires an alert.
- **Volumetric checks:** each completed game should produce exactly two
  teams and a bounded, non-zero range of player rows. Deviations flag before
  reaching Silver.
- **Statistical drift:** rolling distributions of key numeric fields
  (points, minutes, pace) compared week-over-week using **Population
  Stability Index**; a threshold breach flags the field as drifting.
- **Cross-source reconciliation:** for every game covered by both sources,
  field-level agreement is computed and logged. Disagreements are written to
  `source_conflicts` with both values, then resolved by a documented rule
  (primary source wins unless a third check — game logs — corroborates the
  secondary).

## 8. Security & hardening

Non-negotiable, not a backlog item. Every endpoint the internet can reach is
treated as hostile until proven otherwise.

| Surface | Threat | Control |
|---|---|---|
| FastAPI serving layer | Unauthenticated scraping / cost abuse | API key auth on every route, held only by the Next.js BFF's server-side environment — never sent to or reachable from the browser; per-key rate limiting (slowapi / Redis token bucket) |
| Query parameters | SQL injection | SQLAlchemy ORM / parameterized queries only — no raw string-built SQL anywhere |
| Browser ↔ BFF | Cross-origin abuse | Browser only ever calls the Next.js app's own domain — same-origin by construction; CORS on FastAPI locked to the BFF's server origin only |
| Secrets (API keys, DB creds) | Leakage via repo, logs, or client bundle | Env vars via a secrets manager (Railway/Render secrets or Doppler); FastAPI key lives in the BFF's server env, never bundled into client JS, never committed — pre-commit hook + gitleaks in CI |
| Postgres | Lateral compromise if API is breached | Least-privilege roles: `ingestion_writer` (write-only to Bronze/Silver), `api_reader` (read-only on Gold + quality tables) — the public API can never write |
| Dependencies | Known CVEs | `pip-audit` / `npm audit` in CI on every PR; Dependabot/Renovate for patch PRs |
| Transport | Interception | TLS everywhere; reject plaintext HTTP at the edge |
| Admin/ops actions | Untracked changes to live data | Audit log table for any manual write/override, with actor + timestamp |

**Definition of done:** `pip-audit`/`npm audit` clean, no endpoint responds
without a valid key, CORS on FastAPI rejects any origin other than the BFF's,
the FastAPI API key never appears in the browser's network tab or JS bundle,
and a manual pass attempting SQL injection and auth bypass against every
route. Document the pass in the write-up. The BFF is what resolves the
tension that a browser calling FastAPI directly can't both hold no secrets
and authenticate.

## 9. Performance & data freshness

Targets: live state freshness < 30s, API p95 latency < 300ms, dashboard
reconciliation accuracy > 99%, uptime (ingestion + API) 99%+.

- **Freshness:** time from FastAPI emitting a live-state event to the
  browser receiving it over the BFF's SSE stream is logged into
  `quality_metrics` alongside the other drift checks. (If SSE forces a
  fallback to polling on that route, this metric becomes poll-lag instead —
  same table, same SLA target.)
- **Speed:** a small Redis (or Postgres materialized-view) cache in front of
  `/live` and `/quality`; indexes on `(game_id, date)` and
  `(source, pulled_at)`; connection pooling (pgbouncer).
- **Accuracy:** reconciliation, PSI drift, and schema checks are what
  "accurate" cashes out to; SLA target is >99% field-level agreement.
- **Load test before calling it done:** simulate a full live-game window's
  polling + concurrent dashboard viewers (k6 or locust), confirm p95 holds.

## 10. Stretch: live win-probability model (week 4-5)

Once Gold tables are trustworthy, train a lightweight model (gradient-boosted
trees on score differential, time remaining, possession, team form) to
predict live win probability. Model output logs into the same
`quality_metrics` pattern (predicted vs. actual outcome distribution over
time) — reuses existing infra instead of a parallel one.

## 11. Frontend & the "modern, furnished" bar

- **Live Board** — today's games, score and clock, pushed over the BFF's
  SSE stream against `/live` (falls back to short-interval polling only if
  the week-3 SSE-on-Vercel spike doesn't hold up).
- **Data Quality Scorecard** — schema-change timeline, null-rate trend
  lines, agreement-rate gauge, reading from `/quality` via the BFF.
- **Historical Explorer** — searchable game/player box scores from Gold.
- **Predictions** (stretch) — live win-probability curve alongside the
  actual score line.

Next.js API routes are a thin BFF in front of FastAPI: fetch-through pages
(Scorecard, Historical Explorer) are simple request/response; Live Board is
the one route that terminates FastAPI's SSE stream and re-streams it via
`EventSource`. Nothing in the browser ever calls FastAPI directly.

**"Fully furnished" checklist:**
- Every state designed: loading skeletons (not spinners), explicit empty
  state, explicit error/stale-data state (this matters more here — a
  quality-monitoring product going silent when the pipeline breaks can't be
  invisible).
- Live indicates itself — pulsing "LIVE" dot + last-updated timestamp.
- Both themes, real contrast in each, not an inverted palette.
- Responsive down to mobile.
- Accessible: keyboard-navigable, visible focus states, WCAG AA contrast on
  scorecard semantic colors, pair color with icon/label (colorblind-safe).
- Fast to first paint: static shell renders immediately, data streams in.

## 12. Week-by-week plan (6 weeks)

**Week 1 — Foundations & historical backfill**
- Postgres schema (Bronze/Silver/Gold), balldontlie historical backfill
  flow, checkpointed & resumable.
- dbt project skeleton with staging models + first structural tests.
- Basic player-name normalization across seasons.
- Least-privilege DB roles set up from day one (`ingestion_writer` /
  `api_reader`) — retrofitting later is painful.

**Week 2 — Live ingestion & the quality gate**
- Live polling flow against both sources during real game windows.
- Schema fingerprinting, volumetric checks, PSI drift checks, source
  reconciliation logic.
- `quality_metrics` and `schema_change_log` populated with real running
  data, including poll-lag/freshness as its own tracked metric.

**Week 3 — Serving layer & Next.js dashboard v1**
- FastAPI endpoints: `/games`, `/live`, `/quality` — API-key auth and rate
  limiting built in from the first endpoint.
- Next.js BFF wired to FastAPI; SSE route spiked and deployed to real
  Vercel *early this week*, confirmed streaming (not buffered) before the
  rest of the Live Board is built on top of it.
- Next.js components for Live Board + Data Quality Scorecard (functional,
  not yet fully polished).
- GitHub Actions CI: pytest + dbt build on push.

**Week 4 — Security hardening & performance pass**
- Full pass against the security checklist: CORS lockdown, secrets audit,
  `pip-audit`/`npm audit` clean, manual injection/auth-bypass test.
- Redis cache in front of hot endpoints, DB indexing, connection pooling.
- Load test the live-game-window scenario; confirm p95/freshness SLAs.

**Week 5 — UI furnishing & stretch model**
- Full state design (loading/empty/error/stale), live-indicator treatment,
  accessibility pass, mobile responsiveness.
- Historical Explorer page; both themes finished, not just
  dark-mode-by-inversion.
- Win-probability model + prediction-drift logging (stretch — first thing
  cut if the schedule slips).

**Week 6 — Final QA & write-up**
- End-to-end walkthrough against every item in this PRD; fix gaps.
- Record a short demo (include the quality scorecard catching a real drift
  event if one occurred during the build).
- Draft resume bullets and README with real numbers filled in.

## 13. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Public feed changes or disappears without notice | Treat it as untrusted by design — bronze layer + schema drift alerting is built to detect exactly this. |
| Rate limits during live windows | Upgrade balldontlie to ALL-STAR tier (~$10/mo); poll only during actual scheduled game windows. |
| Scope creep into the model swallowing the timeline | Model is explicitly week-4-only and reuses existing drift infrastructure. |
| SSE on Vercel silently buffers/times out in production while working fine locally | The week-3 spike is the real gate, tested against a live deployment. If it fails after following the documented pattern (Node.js runtime, immediate `Response` + background stream, no-buffering header, Fluid Compute), SWR polling becomes the primary path for that route — decided in week 3, not discovered late. |
| Security/UI/performance scope quietly balloons the timeline further | Each has a dedicated week (4 and 5) with a written definition-of-done. If either overruns, cut the ML stretch goal first, never the security pass. |
| Live external API key or DB creds leak | Secrets manager only, gitleaks in CI, and a rotation plan documented even if not automated for v1. |

## 14. Resume narrative

Bullets to extract once built — fill in real numbers:

- Built a two-source data reconciliation pipeline ingesting live and
  historical NBA data from independent APIs, detecting and logging
  field-level disagreements at [X]% of games rather than silently resolving
  them.
- Designed and ran a schema-drift and statistical-drift monitoring system
  (PSI-based) across [N] weeks of live production data, catching [X] real
  upstream schema changes before they broke downstream models.
- Orchestrated batch and streaming ingestion with Prefect, backed by a
  dbt-modeled medallion warehouse in Postgres, with CI-enforced
  data-quality tests on every merge.
- Shipped a live-updating analytics dashboard (Next.js + FastAPI, real-time
  via SSE) surfacing both game data and the pipeline's own data-quality
  metrics in real time.
- Hardened the public API surface with key-based auth, rate limiting,
  least-privilege database roles, and CI-enforced dependency scanning,
  validated with a manual injection/auth-bypass review.

---

Grounded against: balldontlie API docs · Vercel streaming/SSE docs · 2026
orchestration comparisons (Prefect/Dagster/Airflow) · 2026 data-quality
tooling comparisons (dbt tests/Great Expectations/Soda).
