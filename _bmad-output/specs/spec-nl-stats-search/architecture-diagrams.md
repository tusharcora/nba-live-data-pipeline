# Architecture Diagrams

## Request flow (per question)

```mermaid
sequenceDiagram
    participant U as User (browser)
    participant BFF as Next.js BFF (/api/search)
    participant LLM as Claude Haiku 4.5
    participant API as FastAPI tool endpoints
    participant DB as Postgres (Gold, api_reader role)

    U->>BFF: POST question
    BFF->>LLM: question + tool definitions
    LLM-->>BFF: tool_use request
    BFF->>API: call matching tool endpoint
    API->>DB: parameterized, read-only query
    DB-->>API: rows (or an explicit no-match signal)
    API-->>BFF: typed tool result (JSON)
    BFF->>LLM: tool_result
    LLM-->>BFF: final answer, cited
    BFF-->>U: streamed answer
```

The BFF is the only component holding the LLM API key (server-side, never sent to the browser — same pattern as `API_SERVICE_KEY`). FastAPI is the only component that talks to Postgres, using the same `api_reader` role every other read path in this project already uses. The LLM never sees a database credential or a raw SQL surface — only the four named tools in `query-tools.md`.
