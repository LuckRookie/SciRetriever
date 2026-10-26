import {
  parseWorkbenchActionRecord,
  type OperatorInput,
  type WorkbenchActionRecord,
  type WorkbenchArticleCloseOutcome,
  type WorkbenchObservation,
  type WorkbenchSessionOutcome,
  type WorkbenchSessionStop,
} from "@sciretriever/contracts";

/** Same display boundary as observations; never retain input values or URL queries. */
export function activityText(value: string, limit: number): string {
  if (
    /(?:api[_ -]?key|access[_ -]?token|authorization|bearer|cookie|password|secret|token|signature)\s*[:=]/iu.test(
      value,
    )
  )
    return "[redacted]";
  return value.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, "");
}

/** Bounded process-local display facts, independent of the Agent conversation. */
export class BrowserActivityLog {
  private sequence = 0;
  private records: WorkbenchActionRecord[] = [];
  private previous:
    | Pick<WorkbenchObservation, "page_id" | "document_generation" | "url">
    | undefined;
  stop: WorkbenchSessionStop | undefined;
  closedAt: string | undefined;
  outcome: WorkbenchSessionOutcome | undefined;

  snapshot(): readonly WorkbenchActionRecord[] {
    return Object.freeze([...this.records]);
  }
  record(record: Omit<WorkbenchActionRecord, "seq" | "at">): void {
    // Keep ordering even if the wall clock is adjusted while this process runs.
    const at = new Date(
      Math.max(
        Date.now(),
        Date.parse(this.records.at(-1)?.at ?? "1970-01-01T00:00:00.000Z"),
      ),
    ).toISOString();
    const item = parseWorkbenchActionRecord({
      ...record,
      seq: ++this.sequence,
      at,
    });
    this.records = [...this.records.slice(-99), item];
  }
  observe(
    observation: WorkbenchObservation,
    actor: WorkbenchActionRecord["actor"] = "platform",
  ): void {
    const previous = this.previous;
    this.previous = {
      page_id: observation.page_id,
      document_generation: observation.document_generation,
      url: observation.url,
    };
    const switched = previous && previous.page_id !== observation.page_id;
    if (
      switched ||
      !previous ||
      previous.url !== observation.url ||
      previous.document_generation !== observation.document_generation
    ) {
      this.record({
        actor,
        kind: switched ? "tab-switch" : "navigation",
        label: activityText(observation.title, 512),
        ...this.binding(observation),
        ...this.url(observation.url),
      });
    }
  }
  private binding(observation: WorkbenchObservation) {
    return {
      frame_seq: observation.frame_seq,
      observation_revision: observation.observation_revision,
      page_id: observation.page_id,
      document_generation: observation.document_generation,
      viewport: {
        width: observation.viewport.width,
        height: observation.viewport.height,
      },
    };
  }
  private url(value: string): { url?: string } {
    try {
      const url = new URL(value);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return {};
      url.search = "";
      url.hash = "";
      return url.href.length <= 2048 ? { url: url.href } : {};
    } catch {
      return {};
    }
  }
  applied(
    input: OperatorInput,
    observation: WorkbenchObservation,
    result: unknown,
    actor: "agent" | "human",
  ): void {
    if (input.kind === "stop") {
      this.stopped(
        {
          reason: input.reason,
          ...("explanation" in input
            ? { explanation: activityText(input.explanation, 2048) }
            : {}),
        },
        actor,
      );
      return;
    }
    // Do not serialize the input object: type-text contains private user content.
    let point: WorkbenchActionRecord["point"];
    let label: string | undefined;
    if (input.kind === "click-element" || input.kind === "click-point") {
      if (
        result &&
        typeof result === "object" &&
        "point" in result &&
        result.point &&
        typeof result.point === "object" &&
        "x" in result.point &&
        "y" in result.point
      ) {
        const { x, y } = result.point;
        if (
          typeof x === "number" &&
          typeof y === "number" &&
          Number.isFinite(x) &&
          Number.isFinite(y) &&
          x >= 0 &&
          y >= 0 &&
          x < observation.viewport.width &&
          y < observation.viewport.height
        )
          point = { x, y };
      }
      if (
        result &&
        typeof result === "object" &&
        "label" in result &&
        typeof result.label === "string"
      )
        label = activityText(result.label, 512);
      else if (input.kind === "click-element")
        label = observation.elements.find(
          (e) => e.element_id === input.element_id,
        )?.name;
    } else if (input.kind === "press-key") label = input.key;
    this.record({
      actor,
      kind: input.kind,
      ...this.binding(observation),
      ...(point ? { point } : {}),
      ...(label === undefined ? {} : { label: activityText(label, 512) }),
    });
  }
  stopped(
    stop: WorkbenchSessionStop,
    actor: "agent" | "human" | "platform",
  ): void {
    if (this.stop) return;
    this.stop = Object.freeze({
      reason: stop.reason,
      ...(stop.explanation === undefined
        ? {}
        : { explanation: activityText(stop.explanation, 2048) }),
    });
    this.record({
      actor,
      kind: "flow-stopped",
      label: activityText(stop.explanation ?? stop.reason, 512),
    });
  }
  close(outcome: WorkbenchArticleCloseOutcome): void {
    if (this.closedAt) return;
    this.closedAt = new Date().toISOString();
    this.outcome = Object.freeze(
      outcome.kind === "published"
        ? { kind: "published", code: "published" }
        : {
            kind: "retained",
            code:
              outcome.kind === "cancelled"
                ? "browser-flow-cancelled"
                : outcome.code,
          },
    );
    if (outcome.kind === "published")
      this.record({
        actor: "platform",
        kind: "flow-stopped",
        label: "published",
      });
    if (outcome.kind !== "published")
      this.stopped({ reason: this.outcome.code }, "platform");
  }
}
