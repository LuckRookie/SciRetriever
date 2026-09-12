import type { BrowserObservation } from "./observation.js";

import {
  parseBrowserAction,
  parseOperatorInput,
  type BrowserAction,
  type OperatorInput,
} from "@sciretriever/contracts";
export type { BrowserAction, OperatorInput } from "@sciretriever/contracts";

export interface BrowserControlClient {
  readonly role?: "human" | "agent";
  readonly client_id: string;
  readonly workspace_id: string;
}
export interface BrowserControlLease {
  readonly controller_id: string;
  readonly epoch: number;
}
export interface BrowserControlState {
  readonly workspace_id: string;
  readonly viewers: number;
  readonly controller_id: string | null;
  readonly epoch: number;
}

export class BrowserControlError extends Error {
  readonly code = "browser-control" as const;
  constructor() {
    super("browser control operation failed");
    this.name = "BrowserControlError";
  }
}

function reject(): never {
  throw new BrowserControlError();
}

function checkAction(
  action: BrowserAction,
  observation: BrowserObservation,
): void {
  if (action.kind === "stop") return;
  if (action.revision !== observation.revision) reject();
  if (
    action.kind === "click-point" &&
    (action.viewport_version !== observation.viewport_version ||
      action.x < 0 ||
      action.y < 0 ||
      action.x >= observation.viewport.width ||
      action.y >= observation.viewport.height)
  )
    reject();
  if (
    action.kind === "scroll-surface" &&
    (Math.abs(action.delta_x) > 2000 || Math.abs(action.delta_y) > 2000)
  )
    reject();
  if (
    action.kind === "wait-for-change" &&
    (action.timeout_ms < 1 || action.timeout_ms > 120_000)
  )
    reject();
  if (
    action.kind === "click-element" &&
    !/^[a-zA-Z0-9._:-]{1,128}$/u.test(action.element_id)
  )
    reject();
}

export class BrowserControlCoordinator {
  private readonly workspaceId: string;
  private readonly clients = new Map<string, "human" | "agent">();
  private controller: BrowserControlLease | undefined;
  private epoch = 0;

  constructor(workspaceId: string) {
    if (!/^[a-zA-Z0-9._:-]{1,128}$/u.test(workspaceId)) reject();
    this.workspaceId = workspaceId;
  }
  attach(client: BrowserControlClient): BrowserControlState {
    if (client.workspace_id !== this.workspaceId || !client.client_id) reject();
    const role = client.role ?? "human";
    if (
      this.clients.has(client.client_id) &&
      this.clients.get(client.client_id) !== role
    )
      reject();
    this.clients.set(client.client_id, role);
    return this.state();
  }
  detach(clientId: string): BrowserControlState {
    this.clients.delete(clientId);
    if (this.controller?.controller_id === clientId) {
      this.controller = undefined;
      this.epoch += 1;
    }
    return this.state();
  }
  takeover(clientId: string): BrowserControlLease {
    if (!this.clients.has(clientId)) reject();
    this.epoch += 1;
    this.controller = { controller_id: clientId, epoch: this.epoch };
    return this.controller;
  }
  release(clientId: string, epoch: number): BrowserControlState {
    if (
      !this.controller ||
      this.controller.controller_id !== clientId ||
      this.controller.epoch !== epoch
    )
      reject();
    this.controller = undefined;
    this.epoch += 1;
    return this.state();
  }
  state(): BrowserControlState {
    return Object.freeze({
      workspace_id: this.workspaceId,
      viewers: this.clients.size,
      controller_id: this.controller?.controller_id ?? null,
      epoch: this.epoch,
    });
  }
  assertController(clientId: string, epoch: number): void {
    if (
      !this.controller ||
      this.controller.controller_id !== clientId ||
      this.controller.epoch !== epoch
    )
      reject();
  }

  async dispatchOperator(
    clientId: string,
    epoch: number,
    input: OperatorInput,
    observation: BrowserObservation,
    execute: (input: OperatorInput) => Promise<void>,
  ): Promise<void> {
    this.assertController(clientId, epoch);
    if (this.clients.get(clientId) !== "human") reject();
    let parsed: OperatorInput;
    try {
      parsed = parseOperatorInput(input);
    } catch {
      reject();
    }
    if (parsed.kind === "type-text" || parsed.kind === "press-key") {
      if (parsed.revision !== observation.revision) reject();
    } else checkAction(parsed, observation);
    await execute(parsed);
  }

  async dispatch(
    clientId: string,
    epoch: number,
    action: BrowserAction,
    observation: BrowserObservation,
    execute: (action: BrowserAction) => Promise<void>,
  ): Promise<void> {
    if (
      !this.controller ||
      this.controller.controller_id !== clientId ||
      this.controller.epoch !== epoch
    )
      reject();
    let parsed: BrowserAction;
    try {
      parsed = parseBrowserAction(action);
    } catch {
      reject();
    }
    checkAction(parsed, observation);
    await execute(parsed);
  }
}
