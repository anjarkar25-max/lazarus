# Web Telemetry UI Design
- `src/web/server.ts`: Zero-dependency `node:http` server serving static assets from `public/` and streaming SSE events from `ResurrectionOrchestrator`.
- `public/index.html`: Interactive three-column dark-mode dashboard with live agent status badges, spec viewer, code diff output, and real-time fuzzing feed.
