import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";

export class BrowserDisplay {
  private child: ChildProcess | undefined;
  private closing: Promise<void> | undefined;
  async start(): Promise<string> {
    if (this.child) throw new Error("browser display already started");
    const child = spawn(
      "Xvfb",
      [
        "-displayfd",
        "3",
        "-screen",
        "0",
        "1920x1080x24",
        "-nolisten",
        "tcp",
        "-noreset",
      ],
      {
        stdio: ["ignore", "ignore", "ignore", "pipe"],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      },
    );
    this.child = child;
    const pipe = child.stdio[3];
    if (!(pipe instanceof Readable))
      throw new Error("browser display unavailable");
    try {
      return await new Promise<string>((resolve, reject) => {
        let output = "";
        const finish = (error?: Error) => {
          clearTimeout(timer);
          pipe.removeListener("data", data);
          child.removeListener("error", failure);
          child.removeListener("exit", failure);
          if (error) reject(error);
          else resolve(`:${output.trim()}`);
        };
        const failure = () => finish(new Error("browser display unavailable"));
        const data = (chunk: Buffer) => {
          output += chunk.toString("ascii");
          if (output.length > 16) failure();
          else if (output.endsWith("\n")) {
            if (!/^\d{1,6}\n$/u.test(output)) failure();
            else finish();
          }
        };
        const timer = setTimeout(failure, 5000);
        child.once("error", failure);
        child.once("exit", failure);
        pipe.on("data", data);
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  close(): Promise<void> {
    this.closing ??= this.stop();
    return this.closing;
  }
  private async stop(): Promise<void> {
    const child = this.child;
    if (
      !child ||
      child.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return;
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
      await exit;
    } finally {
      clearTimeout(timer);
    }
  }
}
