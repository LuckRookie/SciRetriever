import { describe, expect, it, vi } from "vitest";
import {
  BrowserControlCoordinator,
  BrowserControlError,
  type BrowserAction,
} from "../src/browser/control.js";

const observation = {
  article_id: "article-1",
  page_id: "page-1",
  revision: 4,
  document_version: 2,
  viewport_version: 3,
  url: "https://example.test/a",
  title: "Article",
  viewport: { width: 800, height: 600, device_scale_factor: 1 },
  frame: null,
  frame_truncated: false,
  page_state: "NORMAL" as const,
  capture_state: "NONE" as const,
};

describe("browser control ownership", () => {
  it("allows one controller and invalidates old epochs", async () => {
    const coordinator = new BrowserControlCoordinator("workspace-1");
    coordinator.attach({ client_id: "viewer", workspace_id: "workspace-1" });
    coordinator.attach({ client_id: "operator", workspace_id: "workspace-1" });
    const lease = coordinator.takeover("operator");
    const execute = vi.fn(async (action: BrowserAction) => {
      void action;
    });
    await coordinator.dispatch(
      "operator",
      lease.epoch,
      { kind: "click-point", x: 10, y: 20, revision: 4, viewport_version: 3 },
      observation,
      execute,
    );
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(
      coordinator.dispatch(
        "viewer",
        lease.epoch,
        { kind: "stop", reason: "user" },
        observation,
        execute,
      ),
    ).rejects.toBeInstanceOf(BrowserControlError);
    coordinator.release("operator", lease.epoch);
    await expect(
      coordinator.dispatch(
        "operator",
        lease.epoch,
        { kind: "stop", reason: "user" },
        observation,
        execute,
      ),
    ).rejects.toBeInstanceOf(BrowserControlError);
  });
  it("rejects stale revisions, wrong viewports and out-of-bounds points before execution", async () => {
    const coordinator = new BrowserControlCoordinator("workspace-1");
    coordinator.attach({ client_id: "operator", workspace_id: "workspace-1" });
    const lease = coordinator.takeover("operator");
    const execute = vi.fn(async (action: BrowserAction) => {
      void action;
    });
    await expect(
      coordinator.dispatch(
        "operator",
        lease.epoch,
        {
          kind: "click-point",
          x: 801,
          y: 20,
          revision: 4,
          viewport_version: 3,
        },
        observation,
        execute,
      ),
    ).rejects.toBeInstanceOf(BrowserControlError);
    await expect(
      coordinator.dispatch(
        "operator",
        lease.epoch,
        { kind: "go-back", revision: 3 },
        observation,
        execute,
      ),
    ).rejects.toBeInstanceOf(BrowserControlError);
    expect(execute).not.toHaveBeenCalled();
  });
  it("requires current human control for text input and rejects stale revisions", async () => {
    const coordinator = new BrowserControlCoordinator("workspace-1");
    coordinator.attach({ client_id: "operator", workspace_id: "workspace-1" });
    coordinator.attach({ client_id: "viewer", workspace_id: "workspace-1" });
    const lease = coordinator.takeover("operator");
    const execute = vi.fn(async () => {});
    const input = {
      kind: "type-text" as const,
      element_id: "field-1",
      text: "synthetic input",
      revision: 4,
    };
    await expect(
      coordinator.dispatchOperator(
        "viewer",
        lease.epoch,
        input,
        observation,
        execute,
      ),
    ).rejects.toBeDefined();
    await expect(
      coordinator.dispatchOperator(
        "operator",
        lease.epoch,
        { ...input, revision: 3 },
        observation,
        execute,
      ),
    ).rejects.toBeDefined();
    expect(execute).not.toHaveBeenCalled();
    await coordinator.dispatchOperator(
      "operator",
      lease.epoch,
      input,
      observation,
      execute,
    );
    expect(execute).toHaveBeenCalledTimes(1);
    coordinator.takeover("viewer");
    await expect(
      coordinator.dispatchOperator(
        "operator",
        lease.epoch,
        input,
        observation,
        execute,
      ),
    ).rejects.toBeDefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
