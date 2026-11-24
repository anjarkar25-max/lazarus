// "Red-Team the Sandbox": a fixed catalogue of proof-of-concept attacks that are run inside a pooled sandbox
// worker, followed by a benign canary probe on the same pool. Callers choose an attack by NAME only; the
// snippets below are the only code that ever reaches the sandbox from this module.
import { z } from "zod";
import { SandboxError } from "./errors.js";
import type { PooledProbeRunner } from "./pool.js";

export const RED_TEAM_ATTACKS = ["infinite-loop", "process-exit", "heap-bomb", "prototype-escape"] as const;
export type RedTeamAttack = (typeof RED_TEAM_ATTACKS)[number];

export const RedTeamBodySchema = z.object({ attack: z.enum(RED_TEAM_ATTACKS) }).strict();

interface AttackSpec {
  readonly label: string;
  readonly description: string;
  readonly snippet: string;
  /** Sandbox error the attack is expected to end in, or undefined when it is expected to return a value. */
  readonly expectedCode?: "TIMEOUT" | "EXECUTION_ERROR" | "MEMORY_EXCEEDED";
  /** Value a contained escape attempt returns. */
  readonly expectedOutput?: string;
}

/** Returns "ESCAPED" if any host capability is reachable from probe code, otherwise "NO_HOST_ACCESS". */
const ESCAPE_SNIPPET = [
  "var found = [];",
  "try { var p1 = this.constructor.constructor('return process')(); if (typeof p1.exit === 'function' || typeof p1.mainModule === 'object' || typeof p1.binding === 'function') found.push('process-via-this'); } catch (e) {}",
  "try { var p2 = console.log.constructor('return process')(); if (typeof p2.exit === 'function' || typeof p2.mainModule === 'object') found.push('process-via-console'); } catch (e) {}",
  "try { var r = this.constructor.constructor('return typeof require')(); if (r !== 'undefined') found.push('require'); } catch (e) {}",
  "try { if (typeof process.binding === 'function' || typeof process.kill === 'function') found.push('process-api'); } catch (e) {}",
  "try { if (typeof fetch !== 'undefined' || typeof XMLHttpRequest !== 'undefined') found.push('network'); } catch (e) {}",
  "found.length === 0 ? 'NO_HOST_ACCESS' : 'ESCAPED:' + found.join(',')",
].join(" ");

export const ATTACKS: Readonly<Record<RedTeamAttack, AttackSpec>> = {
  "infinite-loop": {
    label: "Infinite Loop",
    description: "while (true) {} burns CPU until the watchdog kills the worker",
    snippet: "while (true) {}",
    expectedCode: "TIMEOUT",
  },
  "process-exit": {
    label: "process.exit(1)",
    description: "tries to terminate the host process",
    snippet: "process.exit(1)",
    expectedCode: "EXECUTION_ERROR",
  },
  "heap-bomb": {
    label: "256MB Heap Bomb",
    description: "allocates arrays until the worker's 256 MB heap cap is hit",
    snippet: "var hog = []; while (true) { hog.push(new Array(1e6).fill(1.5)); } 0",
    expectedCode: "MEMORY_EXCEEDED",
  },
  "prototype-escape": {
    label: "Hostile Escape",
    description: "walks constructor chains to reach the host realm (process, require, network)",
    snippet: ESCAPE_SNIPPET,
    expectedOutput: "NO_HOST_ACCESS",
  },
};

export interface RedTeamResult {
  readonly attack: RedTeamAttack;
  readonly label: string;
  readonly description: string;
  readonly snippet: string;
  /** The attack did not get out: it was stopped by a sandbox error, or the escape attempt found nothing. */
  readonly contained: boolean;
  /** The outcome is exactly the one the catalogue predicts (a TIMEOUT stays a TIMEOUT, etc.). */
  readonly matchesExpected: boolean;
  readonly outcome: { readonly ok: boolean; readonly errorCode?: string; readonly message?: string; readonly output?: unknown };
  readonly expected: { readonly errorCode?: string; readonly output?: string };
  readonly elapsedMs: number;
  /** Benign follow-up probe `1 + 1` on the same pool. */
  readonly canaryResult: unknown;
  readonly canaryMs: number;
  /** Canary returned 2: the pool serves clean probes again, with nothing carried over. */
  readonly recovered: boolean;
  /** A new worker process was started because the attack forced the old one to be killed. */
  readonly respawned: boolean;
  readonly pidBefore: number | undefined;
  readonly pidAfter: number | undefined;
}

export async function runRedTeam(pool: PooledProbeRunner, attack: RedTeamAttack): Promise<RedTeamResult> {
  const spec = ATTACKS[attack];
  // Warm worker first, so a respawn is attributable to the attack and not to a cold start.
  await pool.run({ code: "0" });
  const pidBefore = pool.workerPid;
  const spawnsBefore = pool.stats.spawns;

  const started = Date.now();
  let outcome: RedTeamResult["outcome"];
  try {
    const res = await pool.run({ code: spec.snippet });
    outcome = { ok: true, output: res.output };
  } catch (err: unknown) {
    const errorCode = err instanceof SandboxError ? err.code : "INTERNAL_ERROR";
    outcome = { ok: false, errorCode, message: err instanceof Error ? err.message : String(err) };
  }
  const elapsedMs = Date.now() - started;

  const canaryStarted = Date.now();
  let canaryResult: unknown;
  try {
    canaryResult = (await pool.run({ code: "1 + 1" })).output;
  } catch (err: unknown) {
    canaryResult = `canary failed: ${err instanceof SandboxError ? err.code : "INTERNAL_ERROR"}`;
  }
  const canaryMs = Date.now() - canaryStarted;

  const pidAfter = pool.workerPid;
  const contained = spec.expectedOutput !== undefined ? outcome.ok && outcome.output === spec.expectedOutput : !outcome.ok;
  const matchesExpected =
    spec.expectedOutput !== undefined ? outcome.ok && outcome.output === spec.expectedOutput : !outcome.ok && outcome.errorCode === spec.expectedCode;
  return {
    attack,
    label: spec.label,
    description: spec.description,
    snippet: spec.snippet,
    contained,
    matchesExpected,
    outcome,
    expected: { ...(spec.expectedCode !== undefined ? { errorCode: spec.expectedCode } : {}), ...(spec.expectedOutput !== undefined ? { output: spec.expectedOutput } : {}) },
    elapsedMs,
    canaryResult,
    canaryMs,
    recovered: canaryResult === 2,
    respawned: pool.stats.spawns > spawnsBefore || (pidBefore !== undefined && pidAfter !== undefined && pidBefore !== pidAfter),
    pidBefore,
    pidAfter,
  };
}
