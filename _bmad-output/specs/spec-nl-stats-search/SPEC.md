---
id: SPEC-nl-stats-search
companions: [query-tools.md, architecture-diagrams.md]
sources: [../../../docs/features/ai-assistant-draft.md]
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Statmuse-Style Natural-Language Stats Search

## Why

The pipeline's Gold data (`games`, `player_game_stats`) is queryable today only through structured browsing on the Explorer/Games pages, and until now `player_game_stats` was empty — there was no real player-level data to search. Both gaps are resolved: the user asked for genuine AI integration for this project, specifically proposed AI "in search terms when trying to search for specific stats," and a prior brainstorm already reached a firm decision on shape — a Statmuse-style natural-language stats lookup, explicitly not a general chatbot (rejected earlier in this project). The nba_api historical backfill has since landed real player-box-score rows, removing the one blocker that kept this feature parked. This spec captures the opportunity: let a user ask a plain-English question about a specific player, team, date, or league leaderboard and get back a correct, source-cited answer computed from this pipeline's own real, already-ingested data.

## Capabilities

- **CAP-1 Natural-language player/team stats query**
  - **intent:** A user asks a specific stats question in plain English (e.g. a player's points on a given date, a team's result in a game) and gets a correct answer without needing to know the underlying schema or endpoints.
  - **success:** For any question whose subject falls inside the ingested date range, the returned answer matches the ground-truth row in `games`/`player_game_stats`.

- **CAP-2 League leaders / aggregate query**
  - **intent:** A user asks a leaderboard-style question (e.g. "who leads in assists") and gets a ranked answer computed from real ingested data.
  - **success:** Every aggregate answer explicitly discloses the date range and game count it was computed over — never a bare number with no scope.

- **CAP-3 Head-to-head / game-result query**
  - **intent:** A user asks about the outcome or stat line of a specific game between two named teams.
  - **success:** The matching game row is returned and reported verbatim with a citation; a non-existent matchup produces the CAP-5 no-data response, not a guess.

- **CAP-4 Transparent sourcing on every answer**
  - **intent:** Every answer states which table and date range it came from.
  - **success:** A user or reviewer can trace any returned number back to a specific tool call and its literal, unmodified result.

- **CAP-5 Honest gap/ambiguity handling**
  - **intent:** When a question has no matching data, or names an ambiguous subject (e.g. two similarly-named players), the system says so instead of guessing.
  - **success:** A zero-row tool result always produces an explicit "no data for that" response; an ambiguous name always produces a clarifying list of candidates; neither path ever produces a fabricated number.

## Constraints

- Ships as its own new page/section, not merged into the existing Explorer page.
- Must be implemented as typed tool-calling (function-calling) against the existing structured Postgres tables — no RAG/vector-embedding approach. The data is small, exact-valued, and already queryable; embedding it would trade deterministic correctness for lossy, hallucination-prone retrieval with no accuracy benefit.
- The tool set exposed to the model is small, fixed, and narrow (see `query-tools.md`) — no general or arbitrary SQL-execution tool. A model with unconstrained SQL access is an injection/data-exposure risk and breaks the least-privilege model the rest of this project relies on.
- Tool query logic lives in new, read-only FastAPI endpoints reusing the existing `api_reader` role. The Next.js BFF route owns only the orchestration loop (calling the LLM, dispatching tool calls, streaming the answer) and holds the LLM API key server-side — the same secret-handling pattern as `API_SERVICE_KEY` today. No new standalone assistant microservice, and no direct Postgres access from the Next.js layer.
- New tool endpoints carry the same `slowapi` rate limiting already applied to every other `api/` route.
- Testing follows this repo's existing offline-verification convention: the FastAPI tool endpoints are tested against fake rows with no live database connection, and the BFF's tool-use loop is tested with the LLM SDK call mocked — no real database or LLM calls run in CI.
- This feature ships as its own branch off `main`, independent of the concurrently in-progress `v2-sportsbook-redesign` branch, so the two land as separately reviewable changes.

## Non-goals

- Persistent multi-turn conversation history or a session/memory model — v1 is stateless per question.
- A voice interface.
- Predictive or generative stat projections (e.g. win-probability) — this duplicates the project's own already-deferred win-probability stretch goal under a different name.
- Fine-tuning a model on this project's data — tool-calling against live Postgres already gives exact, current answers at no training cost.
- A general sports-knowledge chatbot: trivia, historical stats outside this pipeline's own ingested data, or opinions about players. Scope stays "an assistant for this pipeline's real data," not a wrapper around the model's general knowledge.
- Natural-language narration over the data-quality observatory (e.g. explaining why two sources disagreed, or a schema-drift event) — a related but separate feature idea that was surfaced and explicitly not selected for this round.

## Success signal

A user on the new search page types a plain-English question about a specific player's or team's real stats, a league-leader question, or a head-to-head result, and receives a correct, source-cited answer for anything inside the ingested date range — or an explicit "no data for that" response when it falls outside it — with the assistant never fabricating a number in either case.

## Assumptions

- The LLM for this feature is Claude Haiku 4.5, carried forward from earlier project research (cost/speed profile suited to extraction-style workloads) but not independently re-confirmed in this session.
- "Other factors" in the user's original phrasing ("stats on players or teams or dates and other factors") is covered by CAP-1 through CAP-3 (player, team, date, head-to-head, league-leader); no additional query dimension was named.

## Open Questions

- Should league-leader queries (CAP-2) be limited or specially caveated given how few days are currently backfilled, beyond the date-range disclosure already required — or is the disclosure itself sufficient for v1?
- What should the new page be named/routed as (e.g. `/search` vs `/ask`), and where should it be linked from in navigation?
