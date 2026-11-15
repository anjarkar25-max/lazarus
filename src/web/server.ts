import { validateAndNormalizeGitHubUrl, fetchGitHubSpecimen } from "../importer/github.js";
import { generateResurrectionBundle } from "../exporter/bundle.js";
import { scanLegacyAst } from "../sandbox/ast-scanner.js";
import * as fs from "node:fs";
import * as http from "node:http";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { ResurrectionOrchestrator } from "../crew/orchestrator.js";
import { DeterministicModernizer } from "../crew/synthesizer.js";
import type { CodeSynthesizer, CrewEvent, ResurrectionRequest } from "../crew/types.js";
import type { InputSchema } from "../fuzzer/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = nodePath.dirname(__filename);
const publicDir = nodePath.resolve(__dirname, "../../public");

interface ResurrectBody {
  name?: string;
  legacyCode?: string;
  schema?: InputSchema;
  fuzzRuns?: number;
  seed?: number;
  simulateBuggyFirstDraft?: boolean;
}

function readJsonBody(req: http.IncomingMessage): Promise<ResurrectBody> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length > 256_000) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? (JSON.parse(raw) as ResurrectBody) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export function createWebServer(): http.Server {
  return http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    if (method === "GET" && url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "lazarus-operating-table" }));
      return;
    }

    if (method === "GET" && (url === "/" || url === "/index.html")) {
      const indexPath = nodePath.join(publicDir, "index.html");
      if (!fs.existsSync(indexPath)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("index.html not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }

    if (method === "POST" && url === "/api/resurrect") {
      let body: ResurrectBody;
      try {
        body = await readJsonBody(req);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }

      if (!body.legacyCode || typeof body.legacyCode !== "string" || !body.schema || typeof body.schema !== "object") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "legacyCode and schema are required" }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });

      const defaultModernizer = new DeterministicModernizer();
      const synthesizer: CodeSynthesizer = body.simulateBuggyFirstDraft
        ? {
            async synthesize(ctx) {
              if (ctx.attempt === 1) {
                return (
                  "// Attempt 1: Naive modernization using Math.floor\n" +
                  ctx.legacyCode.replace(/\(([^()]+)\)\s*\|\s*0\b/g, "Math.floor($1)")
                );
              }
              return defaultModernizer.synthesize(ctx);
            },
          }
        : defaultModernizer;

      const orchestrator = new ResurrectionOrchestrator({ synthesizer });

      const request: ResurrectionRequest = {
        name: body.name && body.name.trim() ? body.name.trim() : "legacy-specimen",
        legacyCode: scanLegacyAst(body.legacyCode).primaryExpression,
        schema: body.schema,
        fuzzRuns: typeof body.fuzzRuns === "number" ? Math.min(Math.max(body.fuzzRuns, 5), 100) : 25,
        ...(typeof body.seed === "number" ? { seed: body.seed } : {}),
        maxHealingAttempts: 3,
        onEvent: (event: CrewEvent) => {
          res.write(`data: ${JSON.stringify({ kind: "event", event })}\n\n`);
        },
      };

      try {
        const result = await orchestrator.resurrect(request);
        res.write(`data: ${JSON.stringify({ kind: "result", result })}\n\n`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        res.write(`data: ${JSON.stringify({ kind: "error", message })}\n\n`);
      } finally {
        res.end();
      }
      return;
    }

    const routePath = req.url?.split("?")[0];

    if (req.method === "POST" && routePath === "/api/import-github") {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
      }
      try {
        const parsed = JSON.parse(raw || "{}") as { url?: string };
        if (!parsed.url) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing GitHub URL" }));
          return;
        }
        const imported = await fetchGitHubSpecimen(parsed.url);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(imported));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    if (req.method === "POST" && routePath === "/api/export-bundle") {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
      }
      try {
        const parsed = JSON.parse(raw || "{}") as {
          specimenName?: string;
          legacyCode?: string;
          modernCode?: string;
          specMarkdown?: string;
          fuzzRuns?: number;
          healed?: boolean;
        };
        if (!parsed.legacyCode || !parsed.modernCode) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "legacyCode and modernCode are required" }));
          return;
        }
        const bundle = generateResurrectionBundle({
          specimenName: parsed.specimenName ?? "resurrectedSpecimen",
          legacyCode: parsed.legacyCode,
          modernCode: parsed.modernCode,
          specMarkdown: parsed.specMarkdown ?? "# Synthesized Kiro Specification",
          fuzzRuns: parsed.fuzzRuns ?? 50,
          healed: Boolean(parsed.healed),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(bundle));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
}

const isMain =
  process.argv[1] !== undefined &&
  nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const port = Number(process.env.PORT ?? 3000);
  const server = createWebServer();
  server.listen(port, () => {
    console.log(`Lazarus Operating Table listening on http://localhost:${port}`);
  });
}

