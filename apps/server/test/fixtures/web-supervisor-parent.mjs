// Synthetic-only external parent for signal / disconnect regression.
import { startWebSupervisor } from "../../dist/cli/web-supervisor.js";
import process from "node:process";
const controller = new globalThis.AbortController();
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());
const server = await startWebSupervisor({
  home: process.argv[2],
  port: 0,
  access: { host: "127.0.0.1", password: "synthetic-workbench-test-password" },
  signal: controller.signal,
  onReady: (r) => process.send?.({ port: r.port, pid: r.pid }),
});
process.exitCode = await server.stopped;
process.disconnect?.();
