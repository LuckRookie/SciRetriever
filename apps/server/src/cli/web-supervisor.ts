import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  RestartAdmission,
  RestartAdmissionError,
} from "../application/restart-admission.js";
import type {
  ConfigurationApplyRequest,
  ConfigurationApplyState,
} from "@sciretriever/contracts";
import { parseConfigurationApplyState } from "@sciretriever/contracts";
import { unmanagedApply, sourceDetails } from "../configuration/sources.js";
import {
  validateWorkbenchAccess,
  type WorkbenchAccessOptions,
} from "../workbench/access.js";

export const WEB_LIFECYCLE_PROTOCOL = 1;
export interface WorkerReady {
  readonly event: "ready";
  readonly version: 1;
  readonly generation: number;
  readonly runtime_id: string;
  readonly pid: number;
  readonly port: number;
  readonly binding_revision: string;
  readonly catalog: string;
  readonly listen: string;
  readonly urls: readonly string[];
  readonly api_key?: string;
}
export interface WebWorkerStart {
  readonly command: "start";
  readonly version: 1;
  readonly generation: number;
  readonly runtime_id: string;
  readonly parent_pid: number;
  readonly home: string;
  readonly port: number;
  readonly host: string;
  readonly password?: string;
  readonly target_binding_revision: string | null;
  readonly handoff: boolean;
  readonly apply_state: ConfigurationApplyState;
}
export interface WebSupervisorOptions {
  readonly home: string;
  readonly port: number;
  readonly access: WorkbenchAccessOptions;
  readonly signal?: AbortSignal;
  readonly onReady?: (ready: WorkerReady) => void;
  readonly onDiagnostic?: (value: {
    code: string;
    generation: number;
    exit_code?: number | null;
    signal?: string | null;
  }) => void;
  /** Internal package/isolated-process seam; the public CLI never accepts a worker path. */
  readonly workerEntry?: string;
  readonly retryDelays?: readonly number[];
  readonly pollMs?: number;
  readonly closeWarningMs?: number;
  readonly startupTimeoutMs?: number;
}
interface Inspector {
  blockers: ConfigurationApplyState["blockers"];
  binding_revision: string;
  catalog: string;
  external_busy?: boolean;
}
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
export class WebSupervisorError extends Error {
  constructor(readonly code: string) {
    super("web supervisor failed");
  }
}
export interface WebSupervisor {
  readonly ready: WorkerReady;
  readonly state: ConfigurationApplyState;
  readonly stopped: Promise<number>;
  close(): Promise<void>;
}
/** Foreground parent. It owns no Application, catalog connection or public listener. */
export async function startWebSupervisor(
  options: WebSupervisorOptions,
): Promise<WebSupervisor> {
  validateWorkbenchAccess(options.access);
  delete process.env.SCIRETRIEVER_WEB_PASSWORD;
  const entry =
    options.workerEntry ??
    fileURLToPath(new URL("./web-worker.js", import.meta.url));
  let child: ChildProcess | undefined,
    ready: WorkerReady | undefined,
    generation = 0,
    port = options.port;
  let stopping = false,
    protocolFailed = false,
    committed = false,
    apply: ConfigurationApplyRequest | undefined,
    applyCancelled = false;
  let state: ConfigurationApplyState = {
    ...unmanagedApply(),
    managed: true,
    state: "starting",
  };
  let locks: {
    intent?: { release(): Promise<void> };
    activity?: { release(): Promise<void> };
  } = {};
  let applyRun: Promise<void> | undefined;
  const failures: number[] = [];
  const pending = new Map<
    string,
    {
      resolve: (v: Inspector) => void;
      reject: (e: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let resolveStopped!: (code: number) => void;
  const stopped = new Promise<number>((done) => {
    resolveStopped = done;
  });
  let resolveFirst!: (v: WorkerReady) => void,
    rejectFirst!: (e: unknown) => void;
  const first = new Promise<WorkerReady>((done, fail) => {
    resolveFirst = done;
    rejectFirst = fail;
  });
  let childExited: Promise<void> = Promise.resolve();
  const diagnostic = (
    code: string,
    exit_code?: number | null,
    signal?: string | null,
  ) =>
    options.onDiagnostic?.({
      code,
      generation,
      ...(exit_code === undefined ? {} : { exit_code }),
      ...(signal === undefined ? {} : { signal }),
    });
  function post(worker: ChildProcess, message: object): boolean {
    if (!worker.connected) return false;
    const failed = () => {
      if (worker !== child || stopping) return;
      protocolFailed = true;
      diagnostic("web-ipc-disconnected");
      rejectFirst(new WebSupervisorError("web-ipc-disconnected"));
      void stop();
    };
    try {
      // connected is only a snapshot: the peer may close before this write.
      // The callback owns EPIPE/closed-channel errors, including normal teardown.
      worker.send(message, (error) => {
        if (error) failed();
      });
      return true;
    } catch {
      failed();
      return false;
    }
  }
  function send(message: object) {
    if (!child || !post(child, message))
      throw new WebSupervisorError("web-ipc-disconnected");
  }
  function update(changes: Partial<ConfigurationApplyState>) {
    state = parseConfigurationApplyState({
      ...state,
      ...changes,
      updated_at: new Date().toISOString(),
    });
    if (child) post(child, { command: "state", version: 1, generation, state });
  }
  async function release() {
    const held = locks;
    locks = {};
    await held.activity?.release();
    await held.intent?.release();
  }
  function inspect(): Promise<Inspector> {
    const nonce = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(nonce);
        reject(new WebSupervisorError("web-inspect-timeout"));
      }, 10000);
      pending.set(nonce, { resolve, reject, timer });
      send({ command: "inspect", version: 1, generation, nonce });
    });
  }
  function cancelPending() {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new WebSupervisorError("web-worker-exited"));
    }
    pending.clear();
  }
  function failApply(code: string) {
    apply = undefined;
    committed = false;
    update({
      state: "failed",
      can_cancel: false,
      problem: {
        display: "error",
        technical_details: sourceDetails(code, "apply"),
      },
    });
    diagnostic(code);
  }
  async function handoff(request: ConfigurationApplyRequest) {
    const current = () =>
      !applyCancelled && !stopping && apply?.request_id === request.request_id;
    try {
      const initial = await inspect();
      const gate = new RestartAdmission(options.home, [
        ready!.catalog,
        initial.catalog,
      ]);
      for (;;) {
        if (!current()) return;
        try {
          locks.intent = await gate.acquire("intent", "exclusive");
          break;
        } catch (error) {
          if (!(error instanceof RestartAdmissionError)) throw error;
          await sleep(options.pollMs ?? 100);
        }
      }
      if (!current()) return;
      update({ state: "waiting", can_cancel: true });
      for (;;) {
        if (!current()) return;
        const snapshot = await inspect();
        if (!current()) return;
        if (snapshot.binding_revision !== request.target_binding_revision) {
          failApply("configuration-apply-target-stale");
          return;
        }
        update({ blockers: snapshot.blockers });
        if (
          Object.values(snapshot.blockers).some((n) => n > 0) ||
          snapshot.external_busy
        ) {
          await sleep(options.pollMs ?? 100);
          continue;
        }
        try {
          locks.activity = await gate.acquire("activity", "exclusive");
        } catch (error) {
          if (!(error instanceof RestartAdmissionError)) throw error;
          await sleep(options.pollMs ?? 100);
          continue;
        }
        if (!current()) return;
        update({ state: "draining" });
        const final = await inspect();
        if (!current()) return;
        if (final.binding_revision !== request.target_binding_revision) {
          failApply("configuration-apply-target-stale");
          return;
        }
        if (
          Object.values(final.blockers).some((n) => n > 0) ||
          final.external_busy
        ) {
          await locks.activity.release();
          delete locks.activity;
          if (!current()) return;
          update({ state: "waiting", blockers: final.blockers });
          continue;
        }
        committed = true;
        update({ state: "stopping", can_cancel: false });
        send({
          command: "commit",
          version: 1,
          generation,
          request_id: request.request_id,
          target_binding_revision: request.target_binding_revision,
        });
        const warning = setTimeout(() => {
          update({
            state: "failed",
            problem: {
              display: "error",
              technical_details: sourceDetails(
                "configuration-apply-close-stalled",
                "apply",
              ),
            },
          });
          diagnostic("configuration-apply-close-stalled");
        }, options.closeWarningMs ?? 30000);
        await childExited;
        clearTimeout(warning);
        return;
      }
    } catch {
      if (current()) failApply("configuration-apply-handoff-failed");
    } finally {
      if (!committed) await release();
    }
  }
  function launch(handoffBootstrap: boolean, target: string | null): void {
    if (stopping) return;
    generation++;
    const runtimeId = randomUUID();
    update({
      state: "starting",
      runtime_id: runtimeId,
      generation,
      can_cancel: false,
    });
    let startupFailed = false,
      operatorStopped = false,
      workerReady = false,
      lifecycleFailed = false;
    const worker = fork(entry, [], {
      execPath: process.execPath,
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
      env: process.env,
    });
    child = worker;
    const startupTimer = setTimeout(() => {
      startupFailed = true;
      diagnostic("web-startup-timeout");
      rejectFirst(new WebSupervisorError("web-startup-timeout"));
      void stop();
    }, options.startupTimeoutMs ?? 60000);
    let resolveExit!: () => void;
    childExited = new Promise<void>((done) => {
      resolveExit = done;
    });
    worker.on("message", (unknownMessage: unknown) => {
      if (worker !== child) return;
      if (
        !unknownMessage ||
        typeof unknownMessage !== "object" ||
        Array.isArray(unknownMessage)
      ) {
        startupFailed = true;
        void stop();
        return;
      }
      const message = unknownMessage as Record<string, unknown>;
      if (message.version !== 1 || message.generation !== generation) {
        startupFailed = true;
        diagnostic("web-ipc-invalid");
        void stop();
        return;
      }
      if (message.event === "ready") {
        clearTimeout(startupTimer);
        if (stopping) {
          post(worker, { command: "stop", version: 1, generation });
          return;
        }
        const r = message as unknown as WorkerReady;
        if (
          r.pid !== worker.pid ||
          r.runtime_id !== runtimeId ||
          !Number.isInteger(r.port) ||
          r.port < 1 ||
          r.port > 65535 ||
          (port !== 0 && r.port !== port) ||
          (target !== null && r.binding_revision !== target) ||
          typeof r.catalog !== "string" ||
          !r.catalog.startsWith("/") ||
          typeof r.binding_revision !== "string" ||
          !Array.isArray(r.urls) ||
          !r.urls.length
        ) {
          startupFailed = true;
          diagnostic("web-ready-mismatch");
          void stop();
          return;
        }
        workerReady = true;
        ready = r;
        port = r.port;
        update({
          state: handoffBootstrap ? "applied" : "idle",
          current_binding_revision: r.binding_revision,
          runtime_id: runtimeId,
          generation,
          problem: null,
        });
        apply = undefined;
        committed = false;
        void release().then(
          () => {
            send({ command: "open", version: 1, generation });
            options.onReady?.(r);
            resolveFirst(r);
          },
          () => {
            diagnostic("web-handoff-release-failed");
            void stop();
          },
        );
      } else if (message.event === "inspect-result") {
        const id = String(message.nonce),
          p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        clearTimeout(p.timer);
        const v = message.inspection as Inspector;
        if (
          !v ||
          !v.blockers ||
          Object.keys(v.blockers).sort().join() !==
            ["queued", "running", "foreground", "probes", "browser_transfers"]
              .sort()
              .join() ||
          Object.values(v.blockers).some(
            (n) => !Number.isSafeInteger(n) || n < 0,
          ) ||
          typeof v.binding_revision !== "string" ||
          typeof v.catalog !== "string"
        )
          p.reject(new WebSupervisorError("web-inspection-invalid"));
        else p.resolve(v);
      } else if (message.event === "inspect-failed") {
        const id = String(message.nonce),
          p = pending.get(id);
        if (p) {
          pending.delete(id);
          clearTimeout(p.timer);
          p.reject(new WebSupervisorError("web-inspection-failed"));
        }
      } else if (message.event === "apply") {
        const request = message.request as ConfigurationApplyRequest;
        if (
          !request ||
          request.runtime_id !== runtimeId ||
          typeof request.request_id !== "string" ||
          typeof request.target_binding_revision !== "string"
        )
          return;
        if (apply) {
          if (apply.target_binding_revision !== request.target_binding_revision)
            diagnostic("web-apply-conflict");
          return;
        }
        apply = request;
        applyCancelled = false;
        committed = false;
        update({
          state: "waiting",
          request_id: request.request_id,
          target_binding_revision: request.target_binding_revision,
          can_cancel: true,
          problem: null,
        });
        applyRun = (applyRun?.catch(() => undefined) ?? Promise.resolve()).then(
          () => handoff(request),
        );
        void applyRun.catch(() => undefined);
      } else if (message.event === "cancel") {
        const request = message.request as { request_id?: unknown };
        const accepted =
          !!apply && apply.request_id === request?.request_id && !committed;
        if (accepted) {
          applyCancelled = true;
          apply = undefined;
          update({ state: "cancelled", can_cancel: false });
        }
        post(worker, {
          command: "cancel-result",
          version: 1,
          generation,
          nonce: message.nonce,
          accepted,
        });
      } else if (message.event === "startup-failed") {
        startupFailed = true;
        diagnostic("web-startup-failed");
        rejectFirst(new WebSupervisorError("web-startup-failed"));
      } else if (message.event === "operator-stop") {
        operatorStopped = true;
        stopping = true;
      } else if (message.event === "close-failed") {
        lifecycleFailed = true;
        stopping = true;
        diagnostic("web-close-failed");
        update({
          state: "failed",
          can_cancel: false,
          problem: {
            display: "error",
            technical_details: sourceDetails("web-close-failed", "apply"),
          },
        });
      } else {
        startupFailed = true;
        diagnostic("web-ipc-invalid");
        void stop();
      }
    });
    worker.once("error", () => {
      clearTimeout(startupTimer);
      startupFailed = true;
      diagnostic("web-worker-start-failed");
      rejectFirst(new WebSupervisorError("web-worker-start-failed"));
    });
    worker.once("exit", (code, signal) => {
      clearTimeout(startupTimer);
      resolveExit();
      cancelPending();
      if (worker !== child) return;
      if (!workerReady && !stopping && !operatorStopped) startupFailed = true;
      const planned = committed && !!apply && code === 75 && signal === null;
      diagnostic(planned ? "web-apply-exit" : "web-worker-exit", code, signal);
      if (stopping || operatorStopped || startupFailed) {
        stopping = true;
        void release().then(() =>
          resolveStopped(
            startupFailed || lifecycleFailed || protocolFailed ? 1 : 0,
          ),
        );
        rejectFirst(new WebSupervisorError("web-stopped-before-ready"));
        return;
      }
      if (planned) {
        const next = apply!.target_binding_revision;
        launch(true, next);
        return;
      }
      committed = false;
      apply = undefined;
      void release().then(async () => {
        const now = Date.now();
        while (failures[0] !== undefined && now - failures[0] > 60000)
          failures.shift();
        if (failures.length >= 3) {
          diagnostic("web-crash-limit");
          stopping = true;
          resolveStopped(1);
          rejectFirst(new WebSupervisorError("web-crash-limit"));
          return;
        }
        const delay =
          (options.retryDelays ?? [1000, 2000, 4000])[failures.length] ?? 4000;
        failures.push(now);
        diagnostic("web-crash-backoff");
        await sleep(delay);
        if (!stopping) launch(false, null);
      });
    });
    const start: WebWorkerStart = {
      command: "start",
      version: 1,
      generation,
      runtime_id: runtimeId,
      parent_pid: process.pid,
      home: options.home,
      port,
      host: options.access.host ?? "0.0.0.0",
      ...(options.access.password === undefined
        ? {}
        : { password: options.access.password }),
      target_binding_revision: target,
      handoff: handoffBootstrap,
      apply_state: state,
    };
    post(worker, start);
  }
  async function stop(): Promise<void> {
    if (!stopping) {
      stopping = true;
      applyCancelled = true;
      update({
        state: protocolFailed ? "failed" : "stopping",
        can_cancel: false,
        ...(protocolFailed
          ? {
              problem: {
                display: "error",
                technical_details: sourceDetails(
                  "web-ipc-disconnected",
                  "apply",
                ),
              },
            }
          : {}),
      });
      if (child) post(child, { command: "stop", version: 1, generation });
    }
    await childExited;
    await applyRun;
    await release();
    resolveStopped(protocolFailed ? 1 : 0);
  }
  const abort = () => {
    void stop();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  launch(false, null);
  try {
    await first;
    if (options.signal?.aborted) await stop();
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    get ready() {
      return ready!;
    },
    get state() {
      return state;
    },
    stopped: stopped.finally(() =>
      options.signal?.removeEventListener("abort", abort),
    ),
    close: stop,
  };
}
