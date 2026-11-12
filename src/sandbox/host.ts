/// <reference types="node" />
// Task 8: Host entry point — initialises /tmp/lazarus-sandbox, starts the RPC router.

import * as fs from "node:fs";
import { RpcRouter } from "./router.js";

const TMP_DIR = "/tmp/lazarus-sandbox";

function initTmpDir(): void {
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    // Verify it is writable by touching a probe file
    const probe = `${TMP_DIR}/.init-probe`;
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[sandbox-host] Failed to initialise ${TMP_DIR}: ${msg}\n`
    );
    process.exit(1);
  }
}

function main(): void {
  initTmpDir();

  const router = new RpcRouter();

  // Graceful shutdown on SIGTERM / SIGINT
  const shutdown = (): void => {
    router.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
