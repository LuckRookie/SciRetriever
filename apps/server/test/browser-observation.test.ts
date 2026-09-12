import { describe, expect, it } from "vitest";

import {
  BrowserObservationStore,
  type BrowserPageSnapshot,
} from "../src/browser/observation.js";

function source(snapshot: BrowserPageSnapshot) {
  return { snapshot: async () => snapshot };
}

const viewport = { width: 800, height: 600, device_scale_factor: 1 };

describe("browser observation boundary", () => {
  it("increments document and viewport versions and strips unsafe URL parts", async () => {
    const store = new BrowserObservationStore();
    const first = await store.observe(
      "article-1",
      "page-1",
      source({
        url: "https://example.test/article?token=secret#part",
        title: "Article",
        viewport,
        screenshot: new Uint8Array([1, 2]),
      }),
    );
    const second = await store.observe(
      "article-1",
      "page-1",
      source({
        url: "https://example.test/other",
        title: "Login required",
        viewport: { ...viewport, width: 900 },
        screenshot: null,
      }),
      "CANDIDATE",
    );
    expect(first.url).toBe("https://example.test/article");
    expect(first.document_version).toBe(1);
    expect(second.document_version).toBe(2);
    expect(second.viewport_version).toBe(2);
    expect(second.page_state).toBe("LOGIN_REQUIRED");
    expect(second.capture_state).toBe("CANDIDATE");
    expect(store.currentObservation()).toBe(second);
  });

  it("bounds frames, redacts sensitive titles and rejects unsafe snapshots", async () => {
    const store = new BrowserObservationStore();
    const frame = new Uint8Array(2_000_001);
    const observation = await store.observe(
      "article-1",
      "page-1",
      source({
        url: "http://127.0.0.1:8080/a",
        title: "api_key=do-not-observe",
        viewport,
        screenshot: frame,
      }),
    );
    expect(observation.title).toBe("[redacted]");
    expect(observation.frame).toBeNull();
    expect(observation.frame_truncated).toBe(true);
    await expect(
      store.observe(
        "article-1",
        "page-1",
        source({
          url: "file:///tmp/x",
          title: "Article",
          viewport,
          screenshot: null,
        }),
      ),
    ).rejects.toThrow("browser observation failed");
  });
});

it("retains the binding for identical snapshots but invalidates a same-URL replacement document", async () => {
  const store = new BrowserObservationStore();
  const snapshot = {
    document_generation: 9,
    url: "http://127.0.0.1/article",
    title: "Article",
    viewport,
    screenshot: new Uint8Array([1, 2]),
  };
  const first = await store.observe("article-1", "page-1", source(snapshot));
  const same = await store.observe("article-1", "page-1", source(snapshot));
  expect(same).toBe(first);
  const changed = await store.observe(
    "article-1",
    "page-1",
    source({ ...snapshot, document_generation: 10 }),
  );
  expect(changed.document_generation).toBe(10);
  expect(changed.revision).toBe(first.revision + 1);
});
