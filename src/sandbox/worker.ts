/// <reference types="node" />
// Persistent sandbox worker. Spawned by SandboxClient (via PooledProbeRunner) with
// --max-old-space-size=256. Loads the network/fs shims BEFORE any probe code can run, then serves
// validated JSON-RPC 2.0 requests over stdio. Every sandbox.probe runs in a fresh vm context.

import "./shims/network.js";
import "./shims/fs.js";
import { RpcRouter } from "./router.js";
import { VmProbeExecutor } from "./vm-executor.js";

const router = new RpcRouter({ runner: new VmProbeExecutor() });

const shutdown = (): void => {
  router.close();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
