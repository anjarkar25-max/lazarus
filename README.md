# Lazarus — Autonomous Legacy & Dead-Dependency Resurrection Engine

> **Kiroween 2026 (Frankenstein Category)** | **Live Studio:** [lazarus-yf0a.onrender.com](https://lazarus-yf0a.onrender.com) | **MIT License**
>
> **663 passing tests across 35 Vitest suites** · **17 `.kiro/specs/` suites** · **4-Agent Kiro Crew** · **Custom `lazarus-sandbox` MCP Server** · **`tsc --strict: 0 errors`**

Lazarus ingests unmaintained legacy ES5/CommonJS JavaScript—single files, **multi-file `require()` dependency graphs**, live **GitHub** URLs, packages from the **npm Graveyard**, or local directories via **CLI**—and autonomously resurrects them into strict ES2022/TypeScript backed by **exact `Object.is` differential fuzzing**, **live mutation testing**, and **real `tsc --strict` compiler verification**.

## System Architecture

```mermaid
flowchart TD
    A["Legacy ES5 / CommonJS<br/>Single File, Multi-File Graph, GitHub, npm Graveyard, or CLI"] --> B["Archaeologist Agent<br/>Acorn AST Scanner + Pooled Virtual-FS Sandbox MCP"]
    B --> C["Architect Agent<br/>Formal Kiro SPEC, Graph Topology & Invariants"]
    C --> D["Necromancer Agent<br/>Acorn + Astring AST Modernizer<br/>(Prototypes -> Class, Multi-File CJS -> ESM, Type Alchemist)"]
    D --> E["Exorcist Agent<br/>Exact Tagged Object.is fast-check Fuzzer"]
    E -- "Counterexample Found<br/>Speculative Rule Rollback" --> D
    E -- "100% Exact Parity Proven" --> F["Mutation Auditor + tsc --strict Verifier<br/>Prove the Proof (Kill Score) + Zero Compiler Errors"]
    F --> G["Resurrection Certificate + GitHub PR Summary + .zip Archive<br/>Typed .ts, tsconfig.json, git-apply Patch, Vitest Suite, GitHub Actions CI"]
```

## Quick Start

```bash
npm install
npm test                                                                   # 663 tests across 35 suites
npm start                                                                  # Launch Lazarus Studio on http://localhost:3000
npm run mcp                                                                # Start stdio MCP server (lazarus-sandbox)
npm run benchmark                                                          # Run live parity & tsc --strict benchmark across all presets
npm run resurrect -- ./examples/legacy-quantize.cjs --out ./out            # Resurrect a single file via CLI
npm run resurrect -- ./examples/legacy-invoice-engine --out ./out-project  # Resurrect a multi-file CJS directory via CLI
```

## Real-World Legacy Parity Benchmark

| Specimen | Legacy Pattern | Subtle Edge Case Caught / Verified | Verified Outcome |
| :--- | :--- | :--- | :--- |
| `legacy-int-halve` | `var half = (n / 2) \| 0` | `Math.floor` diverges on negative odd integers (`-1` vs `-2`) | Self-healed + `tsc --strict: 0 errors` |
| `stringHash32` | ES5 hash loop with `\| 0` | 32-bit signed overflow (`-2147483648` vs `2147483648`) | Rule rolled back + 5/5 Mutants Killed |
| `legacyCounterClass` | `Counter.prototype.inc = function` | Prototype constructor, `this` binding, stateful methods | Lifted cleanly to ES2022 `class` |
| `cjsMathUtils` | Multi-export `exports.a / exports.b` | Multi-function CommonJS extraction + named ESM exports | 100% Exact Parity across all exports |
| `legacy-invoice-engine` | 3-file CommonJS `require('./...')` graph | Topological leaf-first stitching + whole-graph parity | Typed `.ts` project + `tsconfig.json` |
| `legacy-text-pipeline` | 3-file string pipeline (`trim`/`pad`/`slug`) | Relative CJS imports rewritten cleanly to ES2022 `import` | Typed `.ts` project + `tsc --strict` |
| `left-pad@1.3.0` (npm) | Live CDN fetch (`unpkg`/`jsdelivr`) | String coercion, padding boundaries, SHA-256 provenance | Verified + Resurrection Certificate |
| `fast-truncate-32` | `(a * 3) \| 0` | 32-bit signed truncation and `-0` vs `+0` (`Object.is`) | 100% Exact Parity |
| `es5-ascii-checksum` | `for (var i = 0; ...)` `charCodeAt` | Empty strings, Unicode boundaries, loop scoping | 100% Exact Parity |
| `mixAB` | Multi-parameter ES5 bitwise mix | Multi-parameter Acorn extraction + integer boundaries | 100% Exact Parity |

## Lazarus Studio V8 Highlights

- **3-Tab Studio & Widescreen Verification Deck (`public/index.html`, `src/web/line-diff.ts`):** Pairs a compact 3-column live workspace with a full-width lower Verification Deck so side-by-side Attempt 1 vs. Verified Code, red/green LCS diffs, Resurrection Certificates, Mutation Audits, and PR Bundles render cleanly without horizontal clipping—plus a **1-click 20s Guided Judge Tour**.
- **Live MCP Wire-Trace Inspector (`src/crew/orchestrator.ts`, `src/web/server.ts`):** Streams real-time `lazarus-sandbox` MCP tool invocations (`sandbox_probe`, `ast_scan`, `ts_verify`) with exact execution timings and worker pool reuse telemetry.
- **Multi-File CommonJS Graph Resurrection (`src/crew/graph-resurrector.ts`, `src/sandbox/virtual-fs.ts`):** Uses an isolated in-memory virtual `require()` loader (zero host filesystem access) to resurrect multi-file projects in topological order, render a live **SVG Dependency Graph**, and export typed `.ts` modules + `tsconfig.json` via UI or Directory CLI.
- **"Prove the Proof" Live Mutation Audit & Real `tsc --strict` Verification (`src/crew/mutation-audit.ts`, `src/crew/ts-verifier.ts`):** Injects semantic AST mutants to verify **Mutation Kill Strength** and compiles generated `.ts` output with `tsc --strict` (server-recomputed anti-tamper proofs stamped into the Resurrection Certificate and `SPEC.md`).
- **One-Click GitHub PR Summary, `.zip` Archive & Benchmark CLI (`src/exporter/pr-summary.ts`, `src/exporter/zip.ts`, `src/benchmark.ts`):** Copies a ready-to-paste Markdown PR description, downloads a zero-dependency `.zip` bundle with `.github/workflows/lazarus-parity.yml`, and runs `npm run benchmark` across all presets with **0 leaked Node processes**.
- **17 Kiro Specification Suites (`.kiro/specs/`):** `sandbox`, `mcp-server`, `differential-fuzzer`, `crew-orchestrator`, `web-ui`, `bundle-exporter`, `sandbox-pooling`, `ast-modernizer`, `judge-playground`, `exact-exorcist-and-prototypes`, `npm-graveyard-importer`, `grand-prize-polish`, `module-graph-necromancer`, `mutation-proof-and-types`, `strict-ts-verification`, `studio-ux-and-diff`, and `flagship-studio-polish` (**663 passing tests across 35 suites**).

