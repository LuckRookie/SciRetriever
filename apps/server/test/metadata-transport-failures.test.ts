import { describe, expect, it } from "vitest";
import { topicSearchQuery } from "../src/metadata/ports.js";
import { MetadataService } from "../src/metadata/service.js";
import { NetworkConnectionError } from "../src/network/connection.js";
import { NetworkHttpError } from "../src/network/http.js";
import { CrossrefRestAdapter } from "../src/providers/crossref/metadata.js";
import { services as coreServices } from "../src/providers/core/definition.js";
import {
  createMetadataTransport,
  metadataTransportFailure,
  requestMetadataResponse,
} from "../src/providers/shared/metadata-transport.js";

describe("metadata transport failure semantics", () => {
  it("keeps Retry-After from a Network failure in the stable metadata diagnosis", () => {
    const failure = metadataTransportFailure(
      new NetworkHttpError("redirect-limit", { retryAfterMs: 2_000 }),
    );
    expect(failure.failure).toMatchObject({
      code: "metadata-network-redirect-limit",
      reason:
        "The metadata provider exceeded the allowed redirect limit. Retry-After is 2000 ms.",
    });
  });
  it.each([
    [429, "rate-limited", true],
    [401, "authentication", false],
    [403, "authorization", false],
    [503, "unavailable", true],
    [400, "http", false],
  ] as const)(
    "keeps HTTP %s separate from invalid records",
    async (status, category, retryable) => {
      const adapter = new CrossrefRestAdapter({
        transport: createMetadataTransport(async (request) => {
          expect(request.method).toBe("GET");
          expect(request.timeout_ms).toBe(30_000);
          return {
            status,
            headers: [],
            retry_after_ms: 2_000,
            body: new TextEncoder().encode(
              '{"message":"vendor-private-message"}',
            ),
          };
        }),
      });
      const result = await new MetadataService({
        topic_search_ports: [adapter],
      }).searchTopicProvider("crossref", topicSearchQuery("fixture"), 10);
      expect(result).toMatchObject({
        outcome: "FAILED",
        raw_item_count: 0,
        observations: [],
        failure: { code: `metadata-provider-${category}`, retryable },
      });
      expect(result.failure?.reason).toContain(`HTTP ${status}`);
      expect(result.failure?.reason).toContain("Retry-After is 2000 ms");
      expect(result.retry_after_ms).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("vendor-private-message");
      expect(result.failure?.reason).not.toContain("invalid record");
    },
  );

  it("propagates the provider's Retry-After separately from Network's bounded delay", async () => {
    const adapter = new CrossrefRestAdapter({
      transport: createMetadataTransport(async () => ({
        status: 429,
        headers: [["Retry-After", "180"]],
        retry_after_ms: 120_000,
        body: new Uint8Array(),
      })),
    });
    const result = await new MetadataService({
      topic_search_ports: [adapter],
    }).searchTopicProvider("crossref", topicSearchQuery("fixture"), 10);
    expect(result).toMatchObject({
      outcome: "FAILED",
      retry_after_ms: 180_000,
      failure: { code: "metadata-provider-rate-limited" },
    });
  });

  it.each([
    [403, "0", "metadata-provider-rate-limited", 240_000],
    [403, "1", "metadata-provider-authorization", undefined],
    [401, "0", "metadata-provider-authentication", undefined],
  ] as const)(
    "recognizes explicit CORE quota evidence on HTTP %s with %s remaining",
    async (status, remaining, code, delay) => {
      await expect(
        requestMetadataResponse(
          async () => ({
            status,
            headers: [
              ["X-RateLimit-Remaining", remaining],
              ["X-RateLimit-Retry-After", "240"],
            ],
            body: new Uint8Array(),
          }),
          {
            endpoint: "https://api.core.ac.uk/v3/works/1",
            headers: [],
            body: new Uint8Array(),
          },
          "json",
          coreServices["core-v3"].policy.quotaHeaders,
        ),
      ).rejects.toMatchObject({
        retry_after_ms: delay,
        failure: { code },
      });
    },
  );

  it.each(["timeout", "response-limit", "response-incomplete"] as const)(
    "preserves the Network %s category without an invalid-record diagnosis",
    async (reason) => {
      const transport = createMetadataTransport(async () => {
        throw new NetworkHttpError(reason, {
          cause: new Error("private-network-detail"),
        });
      });
      const adapter = new CrossrefRestAdapter({ transport });
      const result = await new MetadataService({
        topic_search_ports: [adapter],
      }).searchTopicProvider("crossref", topicSearchQuery("fixture"), 1);
      expect(result.failure?.code).toBe(`metadata-network-${reason}`);
      expect(JSON.stringify(result)).not.toContain("private-network-detail");
      expect(result.failure?.reason).not.toContain("invalid record");
    },
  );

  it("retains an accepted page when a later provider request is rate limited", async () => {
    let requests = 0;
    const adapter = new CrossrefRestAdapter({
      pageSize: 1,
      transport: createMetadataTransport(async () => {
        requests += 1;
        return requests === 1
          ? {
              status: 200,
              headers: [],
              body: new TextEncoder().encode(
                JSON.stringify({
                  status: "ok",
                  "message-type": "work-list",
                  message: {
                    items: [
                      { DOI: "10.5555/retained", title: ["Retained page"] },
                    ],
                    "next-cursor": "page2",
                  },
                }),
              ),
            }
          : {
              status: 429,
              headers: [],
              body: new Uint8Array(),
              retry_after_ms: 1_000,
            };
      }),
    });
    const result = await new MetadataService({
      topic_search_ports: [adapter],
    }).searchTopicProvider("crossref", topicSearchQuery("fixture"), 10);
    expect(result).toMatchObject({
      outcome: "FAILED",
      raw_item_count: 1,
      failure: { code: "metadata-provider-rate-limited" },
    });
    expect(result.observations[0]?.metadata.title).toBe("Retained page");
    expect(requests).toBe(2);
  });

  it("distinguishes invalid JSON, connection failure, and an unexpected provider session", async () => {
    const json = createMetadataTransport(async () => ({
      status: 200,
      headers: [],
      body: new TextEncoder().encode("invalid JSON"),
    }));
    const connection = createMetadataTransport(async () => {
      throw new NetworkConnectionError();
    });
    const unexpected = {
      request: async () => {
        throw new Error("private-programming-error");
      },
    };
    for (const [transport, code] of [
      [json, "metadata-provider-response-invalid"],
      [connection, "metadata-network-connection"],
      [unexpected, "metadata-provider-unexpected"],
    ] as const) {
      const adapter = new CrossrefRestAdapter({ transport });
      const result = await new MetadataService({
        topic_search_ports: [adapter],
      }).searchTopicProvider("crossref", topicSearchQuery("fixture"), 1);
      expect(result.failure?.code).toBe(code);
      expect(result.failure?.reason).not.toContain("invalid record");
      expect(JSON.stringify(result)).not.toContain("private-programming-error");
    }
  });
});
