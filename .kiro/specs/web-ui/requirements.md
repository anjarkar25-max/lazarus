# Web Telemetry UI Requirements
- Serve a single-page "Resurrection Operating Table" UI at `GET /`.
- Expose `POST /api/resurrect` streaming `CrewEvent` objects and the final `ResurrectionResult` via Server-Sent Events (`text/event-stream`).
- Provide built-in legacy presets, including a live self-healing demo where Exorcist catches a naive `Math.floor` negative-number bug via `fast-check` and Necromancer auto-patches it to `Math.trunc`.
