import { describe, expect, it } from "vitest";
import { CandidateAcceptanceError } from "../src/acquisition/candidate-acceptance.js";
import {
  AcquisitionRouteError,
  AcquisitionUnavailableError,
  classifyAcquisitionFailure,
  TieredAcquisitionService,
} from "../src/acquisition/tiered.js";
import { LiteraturePublicationError } from "../src/literature/primary-pdf.js";
import { WriteAdmissionError } from "../src/storage/write-admission.js";
import { safeLocator, PublicAcquisitionRegistry } from "../src/index.js";
import type { AcquisitionSourcePort } from "../src/acquisition/ports.js";

function source(
  sourceName: string,
  discover: AcquisitionSourcePort["discover"],
): AcquisitionSourcePort {
  return { source_name: sourceName, ready: true, discover };
}

const item = (key: string) => ({
  key,
  request: { identifiers: [{ namespace: "doi", value: key }] },
});

describe("tiered acquisition batch", () => {
  it("never lets a later unsupported route erase an unresolved transport failure", async () => {
    const sources = [
      source("broken", async () => {
        throw new AcquisitionRouteError(
          "network-failed",
          "Connection timed out.",
        );
      }),
      source("unsupported", async () => {
        throw new AcquisitionUnavailableError(
          "download-unavailable",
          "Public HTTP returned HTML.",
          "http-route-unavailable",
        );
      }),
    ];
    const result = await new TieredAcquisitionService(
      new PublicAcquisitionRegistry(
        sources,
        sources.map((s) => s.source_name),
      ),
    ).run([item("x")], async () => undefined);
    expect(result).toMatchObject([
      {
        disposition: "failed",
        failure: { code: "network-failed", unavailability: null },
      },
    ]);
  });

  it.each(["discovery", "delivery"])(
    "stops alternate requests after a rate limit during %s",
    async (stage) => {
      const calls: string[] = [];
      const limited = source("limited", async () => {
        calls.push("limited");
        if (stage === "discovery")
          throw new AcquisitionRouteError("rate-limited", "HTTP 429.");
        return [
          safeLocator("limited", "https://fixture.test/one.pdf"),
          safeLocator("limited", "https://fixture.test/two.pdf"),
        ];
      });
      const alternate = source("alternate", async () => {
        calls.push("alternate");
        return [];
      });
      const result = await new TieredAcquisitionService(
        new PublicAcquisitionRegistry(
          [limited, alternate],
          ["limited", "alternate"],
        ),
      ).run([item("x")], async () => {
        calls.push("download");
        throw new AcquisitionRouteError("rate-limited", "HTTP 429.");
      });
      expect(result).toMatchObject([
        { failure: { code: "rate-limited", source: "limited" } },
      ]);
      expect(calls).toEqual(
        stage === "discovery" ? ["limited"] : ["limited", "download"],
      );
    },
  );

  it("continues a second public candidate after the first needs a browser session", async () => {
    const calls: string[] = [];
    const direct = source("direct", async () => [
      safeLocator("direct", "https://fixture.test/one.pdf"),
      safeLocator("direct", "https://fixture.test/two.pdf"),
    ]);
    const result = await new TieredAcquisitionService(
      new PublicAcquisitionRegistry([direct], ["direct"]),
    ).run([item("x")], async (_item, _source, candidate) => {
      calls.push(candidate.locator);
      if (calls.length === 1)
        throw new AcquisitionUnavailableError(
          "download-unavailable",
          "Public HTTP returned 403.",
          "http-route-unavailable",
        );
    });
    expect(result).toMatchObject([{ disposition: "acquired" }]);
    expect(calls).toHaveLength(2);
  });

  it("keeps mixed success, exhaustion and source errors separate", async () => {
    const first = source("first", async (request) => {
      const key = request.identifiers[0]?.value;
      if (key === "fail")
        throw new AcquisitionRouteError(
          "source-discovery-failed",
          "fixture source failure",
        );
      if (key === "empty") return [];
      return [safeLocator("first", "https://fixture.test/first.pdf")];
    });
    const fallback = source("fallback", async (request) => {
      if (request.identifiers[0]?.value === "success")
        return [safeLocator("fallback", "https://fixture.test/fallback.pdf")];
      return [];
    });
    const progress: string[] = [];
    const service = new TieredAcquisitionService(
      new PublicAcquisitionRegistry([first, fallback], ["first", "fallback"]),
      { cooldown_ms: 0 },
    );
    const results = await service.run(
      [item("success"), item("empty"), item("fail")],
      async (_item, sourcePort, candidate) => {
        progress.push(`${sourcePort.source_name}:${candidate.locator}`);
      },
      {
        on_progress: (event) =>
          progress.push(`${event.key}:${event.disposition}`),
      },
    );
    expect(results.map((result) => result.disposition)).toEqual([
      "acquired",
      "exhausted",
      "failed",
    ]);
    expect(results[0]).toMatchObject({
      source: "first",
      candidate: { kind: "pdf" },
    });
    expect(results[1]).toMatchObject({ source: null, failure: null });
    expect(results[2]).toMatchObject({
      failure: {
        code: "source-discovery-failed",
        source: "first",
        retryable: true,
      },
    });
    expect(progress).toContain("success:acquired");
  });

  it("applies never, notify and pause without converting a source error to entitlement", async () => {
    const broken = source("broken", async () => {
      throw new AcquisitionRouteError(
        "source-discovery-failed",
        "blocked fixture",
      );
    });
    const registry = new PublicAcquisitionRegistry([broken], ["broken"]);
    const run = (assistance: "never" | "notify" | "pause") =>
      new TieredAcquisitionService(registry, {
        assistance,
        cooldown_ms: 0,
      }).run([item("x")], async () => undefined);
    await expect(run("never")).resolves.toMatchObject([
      { disposition: "failed", failure: { code: "source-discovery-failed" } },
    ]);
    await expect(run("notify")).resolves.toMatchObject([
      { disposition: "skipped", failure: { code: "assistance-skipped" } },
    ]);
    await expect(run("pause")).resolves.toMatchObject([
      { disposition: "interrupted", failure: { code: "assistance-required" } },
    ]);
  });

  it("stops a batch at a cancellation boundary and does not replay completed items", async () => {
    const controller = new AbortController();
    const sourcePort = source("fixture", async () => {
      controller.abort();
      return [safeLocator("fixture", "https://fixture.test/a.pdf")];
    });
    const service = new TieredAcquisitionService(
      new PublicAcquisitionRegistry([sourcePort], ["fixture"]),
      { cooldown_ms: 0 },
    );
    const results = await service.run(
      [item("first"), item("second")],
      async () => undefined,
      { signal: controller.signal },
    );
    expect(results.map((result) => result.disposition)).toEqual([
      "interrupted",
      "interrupted",
    ]);
    expect(results[1]?.failure?.code).toBe("execution-cancelled");
  });
});

describe("tiered acquisition exhaustion boundary", () => {
  it("never reports a cooling-down route as a normal exhaustion", async () => {
    const flaky = source("flaky", async (request) => {
      if (request.identifiers[0]?.value === "first")
        throw new AcquisitionRouteError(
          "source-discovery-failed",
          "fixture provider failure",
        );
      return [];
    });
    const empty = source("empty", async () => []);
    const service = new TieredAcquisitionService(
      new PublicAcquisitionRegistry([flaky, empty], ["flaky", "empty"]),
      { cooldown_ms: 60_000 },
    );
    const results = await service.run(
      [item("first"), item("second")],
      async () => undefined,
    );
    expect(results[0]).toMatchObject({
      disposition: "failed",
      failure: { code: "source-discovery-failed" },
    });
    // The second target skipped the cooling-down route and the remaining route
    // was empty, but a route failure is still unresolved: this is not a normal
    // exhaustion and must never become a durable exhaustion fact.
    expect(results[1]).toMatchObject({
      disposition: "failed",
      failure: { code: "source-cooldown", source: "flaky", retryable: true },
    });
    expect(results[1]?.failure).not.toBeNull();
  });

  it("is exhausted only when every applicable route ended without a failure", async () => {
    const first = source("first", async () => []);
    const second = source("second", async () => []);
    const service = new TieredAcquisitionService(
      new PublicAcquisitionRegistry([first, second], ["first", "second"]),
      { cooldown_ms: 0 },
    );
    const results = await service.run([item("x")], async () => undefined);
    expect(results).toMatchObject([
      { disposition: "exhausted", source: null, failure: null },
    ]);
  });
});

describe("tiered acquisition failure classification", () => {
  it("names cancel, storage, receipt, contract, system and route failures exactly", async () => {
    const active = new AbortController();
    const cancelled = new AbortController();
    cancelled.abort();
    expect(
      classifyAcquisitionFailure(
        new AcquisitionRouteError("candidate-download-failed", "route", true),
        active.signal,
      ),
    ).toBe("route");
    expect(
      classifyAcquisitionFailure(
        new WriteAdmissionError("write-admission-closed"),
        active.signal,
      ),
    ).toBe("storage");
    expect(
      classifyAcquisitionFailure(
        new WriteAdmissionError("write-admission-cancelled"),
        active.signal,
      ),
    ).toBe("cancel");
    expect(
      classifyAcquisitionFailure(
        new CandidateAcceptanceError("candidate-receipt-conflict"),
        active.signal,
      ),
    ).toBe("receipt");
    expect(
      classifyAcquisitionFailure(
        new CandidateAcceptanceError("candidate-command-invalid"),
        active.signal,
      ),
    ).toBe("system");
    expect(
      classifyAcquisitionFailure(
        new LiteraturePublicationError("candidate-uncertain"),
        active.signal,
      ),
    ).toBe("route");
    expect(
      classifyAcquisitionFailure(
        new LiteraturePublicationError("literature-stale"),
        active.signal,
      ),
    ).toBe("system");
    expect(
      classifyAcquisitionFailure(new TypeError("bad input"), active.signal),
    ).toBe("contract");
    expect(
      classifyAcquisitionFailure(
        new Error("provider failure"),
        cancelled.signal,
      ),
    ).toBe("cancel");
    // An unrecognized error is a system failure in both contexts: it must not
    // fall back to another route or become a durable exhaustion fact.
    expect(
      classifyAcquisitionFailure(
        new Error("provider failure"),
        active.signal,
        "discovery",
      ),
    ).toBe("system");
    expect(
      classifyAcquisitionFailure(
        new Error("unexpected internal failure"),
        active.signal,
      ),
    ).toBe("system");
  });

  it("records the fail-closed choice: a non-retryable route error is surfaced, never retried on another route", async () => {
    let discovers = 0;
    const first = source("first", async () => {
      discovers += 1;
      return [safeLocator("first", "https://fixture.test/first.pdf")];
    });
    const fallback = source("fallback", async () => {
      discovers += 1;
      return [safeLocator("fallback", "https://fixture.test/fallback.pdf")];
    });
    const service = new TieredAcquisitionService(
      new PublicAcquisitionRegistry([first, fallback], ["first", "fallback"]),
      { cooldown_ms: 0 },
    );
    const nonRetryable = new AcquisitionRouteError(
      "download-unavailable",
      "the route needs operator action",
      false,
    );
    // The classifier itself treats a non-retryable route error as a system
    // failure, so the batch never gets a disposition Entry could read as a
    // route outcome or as a normal exhaustion.
    expect(
      classifyAcquisitionFailure(nonRetryable, new AbortController().signal),
    ).toBe("system");
    await expect(
      service.run([item("x")], async () => {
        throw nonRetryable;
      }),
    ).rejects.toBe(nonRetryable);
    expect(discovers).toBe(1);
    // A retryable route error, by contrast, is the documented opt-in for
    // fallback and ends as one bounded route failure instead of a rejection.
    const retryable = new AcquisitionRouteError(
      "candidate-download-failed",
      "candidate was rejected",
      true,
    );
    expect(
      classifyAcquisitionFailure(retryable, new AbortController().signal),
    ).toBe("route");
  });

  it("treats an unrecognized discovery exception as a system failure with no fallback", async () => {
    // Recorded decision: an unknown discovery exception is never implicitly a
    // route; a source must opt in with `AcquisitionRouteError` (or raise a known
    // network rejection). Making every production source explicit is a separate
    // review/repair follow-up, not a silent default here.
    let discovers = 0;
    const broken = source("broken", async () => {
      discovers += 1;
      throw new Error("unclassified internal failure");
    });
    const fallback = source("fallback", async () => {
      discovers += 1;
      return [safeLocator("fallback", "https://fixture.test/fallback.pdf")];
    });
    const service = new TieredAcquisitionService(
      new PublicAcquisitionRegistry([broken, fallback], ["broken", "fallback"]),
      { cooldown_ms: 0 },
    );
    await expect(
      service.run([item("x")], async () => undefined),
    ).rejects.toThrow("unclassified internal failure");
    // No route fallback and no `failed`/`exhausted` disposition that Entry could
    // turn into a durable fact.
    expect(discovers).toBe(1);
  });

  it("never swallows an embedded storage-shaped discovery error as a route failure", async () => {
    let discovers = 0;
    const broken = source("broken", async () => {
      discovers += 1;
      throw Object.assign(new Error("disk is full"), { code: "ENOSPC" });
    });
    const fallback = source("fallback", async () => {
      discovers += 1;
      return [safeLocator("fallback", "https://fixture.test/fallback.pdf")];
    });
    const service = new TieredAcquisitionService(
      new PublicAcquisitionRegistry([broken, fallback], ["broken", "fallback"]),
      { cooldown_ms: 0 },
    );
    await expect(
      service.run([item("x")], async () => undefined),
    ).rejects.toMatchObject({ code: "ENOSPC" });
    // The storage-shaped error left the batch at the first source.
    expect(discovers).toBe(1);
  });

  it("keeps every non-route failure out of the batch instead of retrying another route", async () => {
    let discovers = 0;
    const first = source("first", async () => {
      discovers += 1;
      return [safeLocator("first", "https://fixture.test/first.pdf")];
    });
    const fallback = source("fallback", async () => {
      discovers += 1;
      return [safeLocator("fallback", "https://fixture.test/fallback.pdf")];
    });
    const service = new TieredAcquisitionService(
      new PublicAcquisitionRegistry([first, fallback], ["first", "fallback"]),
      { cooldown_ms: 0 },
    );
    const route = await service.run([item("x")], async () => {
      throw new AcquisitionRouteError(
        "candidate-download-failed",
        "candidate was rejected",
      );
    });
    expect(route).toMatchObject([
      {
        disposition: "failed",
        failure: { code: "candidate-download-failed", retryable: true },
      },
    ]);
    // Both sources were attempted, so the route failure did fall back.
    expect(discovers).toBe(2);

    for (const failure of [
      new WriteAdmissionError("write-admission-closed"),
      new CandidateAcceptanceError("candidate-receipt-conflict"),
      new LiteraturePublicationError("literature-stale"),
      new Error("unexpected internal failure"),
    ]) {
      discovers = 0;
      await expect(
        service.run([item("x")], async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      // The batch left at the first source: no candidate or source fallback.
      expect(discovers).toBe(1);
    }

    const controller = new AbortController();
    const cancelled = await service.run(
      [item("x")],
      async () => {
        controller.abort();
        throw new Error("delivery was cancelled");
      },
      { signal: controller.signal },
    );
    expect(cancelled).toMatchObject([
      { disposition: "interrupted", failure: { code: "execution-cancelled" } },
    ]);

    const blocked = source("blocked", async () => {
      throw new WriteAdmissionError("write-admission-closed");
    });
    await expect(
      new TieredAcquisitionService(
        new PublicAcquisitionRegistry([blocked], ["blocked"]),
        { cooldown_ms: 0 },
      ).run([item("x")], async () => undefined),
    ).rejects.toBeInstanceOf(WriteAdmissionError);
  });

  it("records a declared low-risk unavailability instead of cooling the route down", async () => {
    let discovers = 0;
    const declared = source("declared", async () => {
      discovers += 1;
      throw new AcquisitionUnavailableError(
        "download-unavailable",
        "the route has no PDF capability for this target",
        "no-capability",
      );
    });
    // A long cooldown with a frozen clock: if the declaration had been treated as a route
    // failure, the second item would have stopped on `source-cooldown` instead.
    const service = new TieredAcquisitionService(
      new PublicAcquisitionRegistry([declared], ["declared"]),
      { cooldown_ms: 60_000, now: () => 0 },
    );
    const results = await service.run(
      [item("first"), item("second")],
      async () => {
        throw new Error("no candidate may be delivered");
      },
    );
    expect(results.map((result) => result.disposition)).toEqual([
      "failed",
      "failed",
    ]);
    for (const result of results)
      expect(result).toMatchObject({
        failure: {
          code: "download-unavailable",
          source: "declared",
          retryable: false,
          unavailability: "no-capability",
        },
      });
    // Both items were attempted: the declaration is not a failure and never cools down.
    expect(discovers).toBe(2);
  });

  it("never infers an unavailability from a failure code", async () => {
    const temporary = source("temporary", async () => {
      throw new AcquisitionRouteError(
        "source-discovery-failed",
        "temporary provider failure",
      );
    });
    const declared = source("declared", async () => {
      throw new AcquisitionUnavailableError(
        "source-discovery-failed",
        "the route does not apply to this target",
        "not-applicable",
      );
    });
    const run = (port: AcquisitionSourcePort) =>
      new TieredAcquisitionService(
        new PublicAcquisitionRegistry([port], [port.source_name]),
        { cooldown_ms: 0 },
      ).run([item("x")], async () => undefined);
    // Identical code, opposite disposition: a temporary failure stays retryable with no
    // unavailability, and only the explicit declaration is recorded as low-risk.
    await expect(run(temporary)).resolves.toMatchObject([
      {
        disposition: "failed",
        failure: {
          code: "source-discovery-failed",
          retryable: true,
          unavailability: null,
        },
      },
    ]);
    await expect(run(declared)).resolves.toMatchObject([
      {
        disposition: "failed",
        failure: {
          code: "source-discovery-failed",
          retryable: false,
          unavailability: "not-applicable",
        },
      },
    ]);
  });

  it("stops only the declaring route and still lets the next route deliver", async () => {
    const declared = source("declared", async () => [
      safeLocator("declared", "https://fixture.test/declared.pdf"),
    ]);
    const fallback = source("fallback", async () => [
      safeLocator("fallback", "https://fixture.test/fallback.pdf"),
    ]);
    const service = new TieredAcquisitionService(
      new PublicAcquisitionRegistry(
        [declared, fallback],
        ["declared", "fallback"],
      ),
      { cooldown_ms: 0 },
    );
    const results = await service.run(
      [item("x")],
      async (_item, sourcePort) => {
        // The declaration concerns the whole route/target, so the remaining candidates of
        // this source are skipped and the next route is still tried.
        if (sourcePort.source_name === "declared")
          throw new AcquisitionUnavailableError(
            "candidate-download-failed",
            "the route has no PDF capability for this source",
            "no-capability",
          );
      },
    );
    expect(results).toMatchObject([
      {
        disposition: "acquired",
        source: "fallback",
        attempted_sources: ["declared", "fallback"],
      },
    ]);
  });
});
