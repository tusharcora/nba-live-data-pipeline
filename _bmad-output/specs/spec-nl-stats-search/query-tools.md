# Query Tools (v1)

Each tool is a thin, read-only wrapper over a Gold table, exposed as a new FastAPI endpoint under the existing `api_reader` role. The LLM calls these by name with typed parameters; it never generates SQL and never receives raw table access.

| Tool | Parameters | Returns | Notes |
|---|---|---|---|
| `get_player_stats` | `player_name`, `date` or `date_range` | Per-game stat line(s) for the matched player over the range | Fuzzy name match. Zero matches → explicit no-data signal (CAP-5). More than one close match → a candidate list for the model to disambiguate, not a guess. |
| `get_team_games` | `team`, `date` or `date_range` | Game rows (opponent, score, date) for the team over the range | Same zero-match / ambiguous-team handling as `get_player_stats`. |
| `get_leaders` | `stat`, `date_range`, `limit` | Ranked list of players or teams by the requested stat over the range | The date range and game count the ranking was computed over are part of the return payload itself (not left to the model to add), so CAP-2's disclosure requirement can't be silently dropped. |
| `get_game_result` | `team_a`, `team_b`, `date` | The specific game's final score and, where available, its box score | Zero matches → explicit no-data signal (CAP-5), never a guessed score. |

All four tools return an explicit "no rows" / "no match" signal rather than an empty list on a miss, giving the model something unambiguous to relay honestly instead of a shape it could paper over.
