// Synthetic IPC violations / cooperative startup timeout. Never opens a listener or catalog.
import { readFile } from "node:fs/promises";
import process from "node:process";
import { join } from "node:path";
process.on("message", async (message) => {
  if (message.command === "stop") {
    process.exitCode = 0;
    process.disconnect();
    return;
  }
  if (message.command !== "start") return;
  const scenario = await readFile(join(message.home, "scenario"), "utf8");
  if (scenario === "never-ready") return;
  process.send({
    event: "ready",
    version: scenario === "wrong-version" ? 99 : 1,
    generation:
      scenario === "wrong-generation"
        ? message.generation + 1
        : message.generation,
  });
});
