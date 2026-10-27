import { randomUUID } from "node:crypto";
import { startProductionWorkbench } from "../bootstrap/workbench.js";
import { TypeScriptConfigurationOwner } from "../configuration/owner.js";
import {
  sourceConfiguration,
  sourceBindingRevision,
} from "../configuration/sources.js";
import {
  bundlePreview,
  loadCredentialBundle,
} from "../configuration/credentials.js";
import { ManagedConfigurationLifecycle } from "../configuration/apply.js";
import { issueRestartBootstrapPermit } from "../application/restart-admission.js";
import { acquireExecutionRuntime } from "../storage/execution/runtime-owner.js";
import { WriteAdmissionError } from "../storage/write-admission.js";
import { parseConfigurationApplyState } from "@sciretriever/contracts";
import type { WebWorkerStart } from "./web-supervisor.js";

/** Shared private worker runtime, with an offline composition seam for lifecycle tests. */
export function runWebWorker(
  startWorkbench: typeof startProductionWorkbench = startProductionWorkbench,
): void {
  /** Private IPC-only worker; it is deliberately not a CLI subcommand. */
  let start: WebWorkerStart | undefined;
  let running: Awaited<ReturnType<typeof startProductionWorkbench>> | undefined;
  let lifecycle: ManagedConfigurationLifecycle | undefined;
  let starting: Promise<void> | undefined, closing: Promise<void> | undefined;
  const cancelRequests = new Map<string, (accepted: boolean) => void>();
  const send = (value: object) => {
    if (!process.connected) return;
    try {
      process.send?.(value, (error: Error | null) => {
        if (error) void close(0);
      });
    } catch {
      void close(0);
    }
  };
  function packet(value: object) {
    return { version: 1, generation: start?.generation ?? 0, ...value };
  }
  async function close(code: number): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      await starting;
      try {
        await running?.close();
        process.exitCode = code;
        if (process.connected) process.disconnect?.();
      } catch {
        send(packet({ event: "close-failed" }));
        process.exitCode = 1;
        if (process.connected) process.disconnect?.();
      }
    })();
    return closing;
  }
  async function boot(request: WebWorkerStart): Promise<void> {
    const owner = new TypeScriptConfigurationOwner(request.home);
    // On initial boot only, persist the same default paths as the public Workbench.
    const snapshot = request.handoff
      ? await owner.read()
      : await owner.ensureStoragePaths();
    const credentials = await loadCredentialBundle(request.home);
    if (
      request.target_binding_revision &&
      sourceBindingRevision(
        snapshot.configuration,
        bundlePreview(credentials),
      ) !== request.target_binding_revision
    )
      throw new Error("startup-target-stale");
    lifecycle = new ManagedConfigurationLifecycle(
      request.runtime_id,
      request.generation,
      request.apply_state,
      (value) => send(packet({ event: "apply", request: value })),
      (value) =>
        new Promise<boolean>((resolve) => {
          const nonce = randomUUID();
          cancelRequests.set(nonce, resolve);
          send(packet({ event: "cancel", request: value, nonce }));
        }),
    );
    running = await startWorkbench({
      home: request.home,
      port: request.port,
      access: {
        host: request.host,
        ...(request.password === undefined
          ? {}
          : { password: request.password }),
      },
      lifecycle,
      applicationOptions: {
        configurationOwner: owner,
        configurationSnapshot: snapshot,
        startupCredentials: credentials,
        ...(request.handoff
          ? {
              restartBootstrapPermit: issueRestartBootstrapPermit(
                request.parent_pid,
              ),
            }
          : {}),
      },
    });
    // Drop the IPC payload's password reference before Browser/Agent work can begin.
    const { password: _password, ...safeStart } = request;
    void _password;
    start = safeStart;
    await lifecycle.ready();
    if (request.handoff) running.application.restartAdmission!.freeze(true);
    const d = await sourceConfiguration(owner).directory();
    if (
      request.target_binding_revision &&
      d.binding_revision !== request.target_binding_revision
    )
      throw new Error("startup-target-stale");
    send(
      packet({
        event: "ready",
        pid: process.pid,
        runtime_id: request.runtime_id,
        port: Number(new URL(running.origin).port),
        binding_revision: d.runtime!.binding_revision,
        catalog: running.application.configuration.paths.catalog_path,
        listen: running.listenAddress,
        urls: running.urls,
        ...(running.apiKey === undefined ? {} : { api_key: running.apiKey }),
      }),
    );
  }
  async function inspect(nonce: unknown): Promise<void> {
    if (!lifecycle || typeof nonce !== "string") throw new Error("ipc-invalid");
    const inspection = await lifecycle.inspect();
    if (!Object.values(inspection.blockers).some((n) => n > 0)) {
      try {
        const lease = await acquireExecutionRuntime(inspection.catalog);
        await lease.release();
      } catch (error) {
        if (
          error instanceof WriteAdmissionError &&
          error.code === "write-admission-conflict"
        )
          Object.assign(inspection, { external_busy: true });
        else throw error;
      }
    }
    send(packet({ event: "inspect-result", nonce, inspection }));
  }
  if (!process.send || !process.connected) process.exitCode = 1;
  else {
    process.on("message", (value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        void close(1);
        return;
      }
      const m = value as Record<string, unknown>;
      if (!start) {
        if (
          m.command !== "start" ||
          m.version !== 1 ||
          m.parent_pid !== process.ppid ||
          !Number.isSafeInteger(m.generation) ||
          typeof m.runtime_id !== "string" ||
          typeof m.home !== "string" ||
          !m.home.startsWith("/") ||
          typeof m.port !== "number" ||
          typeof m.host !== "string"
        ) {
          process.exitCode = 1;
          if (process.connected) process.disconnect?.();
          return;
        }
        start = m as unknown as WebWorkerStart;
        starting = boot(start).catch(() => {
          send(packet({ event: "startup-failed" }));
          process.exitCode = 1;
          if (process.connected) process.disconnect?.();
        });
        return;
      }
      if (m.version !== 1 || m.generation !== start.generation) {
        void close(1);
        return;
      }
      if (m.command === "stop") {
        void close(0);
        return;
      }
      if (m.command === "state") {
        try {
          lifecycle?.update(parseConfigurationApplyState(m.state));
        } catch {
          void close(1);
        }
        return;
      }
      if (m.command === "open") {
        running?.application.restartAdmission?.freeze(false);
        return;
      }
      if (m.command === "inspect") {
        void inspect(m.nonce).catch(() => {
          send(packet({ event: "inspect-failed", nonce: m.nonce }));
        });
        return;
      }
      if (m.command === "cancel-result") {
        const nonce = String(m.nonce);
        cancelRequests.get(nonce)?.(m.accepted === true);
        cancelRequests.delete(nonce);
        return;
      }
      if (m.command === "commit") {
        const state = lifecycle?.state();
        if (
          !state ||
          state.request_id !== m.request_id ||
          state.target_binding_revision !== m.target_binding_revision ||
          state.can_cancel
        ) {
          void close(1);
          return;
        }
        void close(75);
        return;
      }
      void close(1);
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        send(packet({ event: "operator-stop" }));
        void close(0);
      });
    process.once("disconnect", () => {
      for (const resolve of cancelRequests.values()) resolve(false);
      cancelRequests.clear();
      void close(0);
    });
  }
}
