import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest, type IncomingMessage } from "node:http";
import {
  link,
  mkdtemp,
  open,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAsset,
  parseDeviceConnectionCode,
  sha256,
} from "@sciretriever/contracts";
import { expect, it, vi } from "vitest";
import {
  createApplication,
  createQueryApplication,
  type Application,
  type QueryApplication,
} from "../src/bootstrap/application.js";
import { deviceBusinessRoutes } from "../src/bootstrap/device-routes.js";
import type { DocumentReadService } from "../src/document/read.js";
import {
  startQueryOnlyHttp,
  startWorkbenchHttp,
} from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";

const base = "/api/v1/query/material-bytes";
const literature = FIXTURE_LITERATURE.literature_id;
const clientHeader = "X-Sciretriever-Client-Id";
const cacheControl = "private, max-age=31536000, immutable";
const chunkSize = 1024 * 1024;

async function material(app: Application, bytes: Buffer, primary: boolean) {
  const asset_id = randomUUID();
  const path = `objects/${asset_id}.pdf`;
  const asset = parseAsset({
    asset_id,
    sha256: await sha256(bytes),
    size_bytes: bytes.length,
    media_type: "application/pdf",
    path,
  });
  const stage = await app.files.stage();
  await stage.write(bytes);
  await app.files.publish(stage, path);
  await app.database.putLiteratureAsset({
    literature_asset_id: randomUUID(),
    literature_id: literature,
    asset,
    role: primary ? "primary-pdf" : "supplementary-pdf",
    source_url: null,
    provenance: {
      provenance_id: randomUUID(),
      source_kind: "asset-provider",
      source_name: "fixture",
      source_record_id: null,
      observed_at: "2026-11-22T00:00:00Z",
      input_sha256: asset.sha256,
      parameters_sha256: null,
    },
  });
  return {
    asset,
    bytes,
    request: {
      literature_id: literature,
      asset_id,
      asset_sha256: asset.sha256,
    },
    url: `${base}/${encodeURIComponent(literature)}/${asset_id}/${asset.sha256}`,
  };
}

async function fixture(padding = 0) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-material-range-"));
  let app: Application | undefined;
  let query: QueryApplication | undefined;
  const close = async () => {
    try {
      await query?.close();
    } finally {
      try {
        await app?.close();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  };
  try {
    app = await createApplication(home, {
      indexRefreshIntervalMs: null,
      browserHost: () => null,
    });
    await app.database.putLiterature(FIXTURE_LITERATURE);
    const pdf = Buffer.from(workbenchPdf());
    const primary = await material(
      app,
      Buffer.concat([pdf, Buffer.alloc(padding, 7)]),
      true,
    );
    const supplement = await material(
      app,
      Buffer.concat([pdf, Buffer.from("\n% fixture supplement\n")]),
      false,
    );
    query = await createQueryApplication(home);
    return {
      app,
      query,
      primary,
      supplement,
      path: join(app.files.root, primary.asset.path),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

const bytes = async (response: Response) =>
  Buffer.from(await response.arrayBuffer());
function headers(
  response: Response,
  value: Awaited<ReturnType<typeof material>>,
) {
  expect(response.headers.get("accept-ranges")).toBe("bytes");
  expect(response.headers.get("etag")).toBe(`"${value.asset.sha256}"`);
  expect(response.headers.get("cache-control")).toBe(cacheControl);
  expect(response.headers.get("vary")).toBe(
    "Cookie, Authorization, Origin, Sec-Fetch-Site",
  );
  expect(response.headers.get("x-sciretriever-protocol-version")).toBe("1");
  expect(response.headers.get("x-sciretriever-asset-id")).toBe(
    value.asset.asset_id,
  );
  expect(response.headers.get("x-sciretriever-asset-sha256")).toBe(
    value.asset.sha256,
  );
  expect(response.headers.get("x-sciretriever-byte-size")).toBe(
    String(value.bytes.length),
  );
}

it("serves the selected primary or supplementary original and preserves the POST byte contract", async () => {
  const f = await fixture();
  const http = await startQueryOnlyHttp({ application: f.query });
  try {
    for (const value of [f.primary, f.supplement]) {
      const response = await fetch(http.origin + value.url);
      expect(response.status).toBe(200);
      headers(response, value);
      expect(response.headers.get("content-type")).toBe("application/pdf");
      expect(response.headers.get("content-disposition")).toBe(
        `attachment; filename="${value.asset.asset_id}.pdf"`,
      );
      expect(response.headers.get("content-length")).toBe(
        String(value.bytes.length),
      );
      expect(response.headers.has("content-range")).toBe(false);
      expect(await bytes(response)).toEqual(value.bytes);
    }
    const legacy = await fetch(
      http.origin + f.primary.url + "?client_id=stale",
    );
    expect(legacy.status).toBe(400);
    expect(await legacy.json()).toEqual({
      protocol_version: 1,
      code: "invalid-query",
    });
    const post = await fetch(http.origin + base, {
      method: "POST",
      headers: { "Content-Type": "application/json", Range: "bytes=0-1" },
      body: JSON.stringify({
        protocol_version: 1,
        request: f.supplement.request,
      }),
    });
    expect(post.status).toBe(200);
    expect(post.headers.get("cache-control")).toBe("no-store");
    expect(post.headers.has("etag")).toBe(false);
    expect(post.headers.has("content-range")).toBe(false);
    expect(post.headers.get("x-sciretriever-asset-sha256")).toBe(
      f.supplement.asset.sha256,
    );
    expect(await bytes(post)).toEqual(f.supplement.bytes);
  } finally {
    await http.close();
    await f.close();
  }
});

it("serves closed, open-ended and suffix byte ranges with clamping", async () => {
  const f = await fixture();
  const http = await startQueryOnlyHttp({ application: f.query });
  try {
    const size = f.primary.bytes.length;
    const ranges = [
      ["bytes=0-0", 0, 0],
      ["bytes=2-15", 2, 15],
      ["bytes=5-", 5, size - 1],
      ["bytes=-11", size - 11, size - 1],
      ["bytes=8-99999999999999999999999999", 8, size - 1],
      ["bytes=-99999999999999999999999999", 0, size - 1],
    ] as const;
    for (const [range, start, end] of ranges) {
      const response = await fetch(http.origin + f.primary.url, {
        headers: { Range: range },
      });
      expect(response.status).toBe(206);
      headers(response, f.primary);
      expect(response.headers.get("content-range")).toBe(
        `bytes ${start}-${end}/${size}`,
      );
      expect(response.headers.get("content-length")).toBe(
        String(end - start + 1),
      );
      expect(await bytes(response)).toEqual(
        f.primary.bytes.subarray(start, end + 1),
      );
    }
  } finally {
    await http.close();
    await f.close();
  }
});

it("rejects invalid single ranges and sends the full representation for unsupported range sets", async () => {
  const f = await fixture();
  const http = await startQueryOnlyHttp({ application: f.query });
  try {
    const size = f.primary.bytes.length;
    for (const Range of [
      `bytes=${size}-`,
      "bytes=10-5",
      "bytes=-0",
      "bytes=-",
      "bytes=bogus",
    ]) {
      const response = await fetch(http.origin + f.primary.url, {
        headers: { Range },
      });
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe(`bytes */${size}`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await bytes(response)).length).toBe(0);
    }
    for (const Range of ["bytes=0-1,8-9", "pages=0-1"]) {
      const response = await fetch(http.origin + f.primary.url, {
        headers: { Range },
      });
      expect(response.status).toBe(200);
      expect(response.headers.has("content-range")).toBe(false);
      expect(await bytes(response)).toEqual(f.primary.bytes);
    }
  } finally {
    await http.close();
    await f.close();
  }
});

it("revalidates the selected representation before Range and honors a strong If-Range validator", async () => {
  const f = await fixture();
  const http = await startQueryOnlyHttp({ application: f.query });
  try {
    const url = http.origin + f.primary.url;
    const etag = `"${f.primary.asset.sha256}"`;
    for (const validator of [etag, `"unrelated,tag", W/${etag}`, "*"]) {
      const response = await fetch(url, {
        headers: { "If-None-Match": validator, Range: "bytes=999999-" },
      });
      expect(response.status).toBe(304);
      headers(response, f.primary);
      expect(response.headers.has("content-range")).toBe(false);
      expect(await response.text()).toBe("");
    }
    const exact = await fetch(url, {
      headers: { "If-Range": etag, Range: "bytes=0-1" },
    });
    expect(exact.status).toBe(206);
    expect(await bytes(exact)).toEqual(f.primary.bytes.subarray(0, 2));
    for (const validator of ['"different"', `W/${etag}`]) {
      const response = await fetch(url, {
        headers: {
          "If-Range": validator,
          "If-None-Match": '"different"',
          Range: "bytes=0-1",
        },
      });
      expect(response.status).toBe(200);
      expect(await bytes(response)).toEqual(f.primary.bytes);
    }
  } finally {
    await http.close();
    await f.close();
  }
});

it("checks catalog binding, actual size, and no-link file admission before sending bytes or 304", async () => {
  const f = await fixture();
  const http = await startQueryOnlyHttp({ application: f.query });
  try {
    const requestHeaders = { "If-None-Match": "*", Range: "bytes=0-1" };
    const failures = [
      [
        f.primary.url.replace(
          f.primary.asset.sha256,
          f.supplement.asset.sha256,
        ),
        409,
        "material-stale",
      ],
      [
        f.primary.url.replace(f.primary.asset.asset_id, randomUUID()),
        404,
        "material-missing",
      ],
      [
        f.primary.url.replace(f.primary.asset.sha256, "bad-hash"),
        400,
        "document-invalid",
      ],
    ] as const;
    for (const [path, status, code] of failures) {
      const reply = await fetch(http.origin + path, {
        headers: requestHeaders,
      });
      expect(reply.status).toBe(status);
      expect(reply.headers.get("cache-control")).toBe("no-store");
      expect(await reply.json()).toEqual({ protocol_version: 1, code });
    }
    const denied = async () => {
      const reply = await fetch(http.origin + f.primary.url, {
        headers: requestHeaders,
      });
      expect(reply.status).toBe(503);
      expect(reply.headers.get("cache-control")).toBe("no-store");
      expect(await reply.json()).toMatchObject({ code: "document-integrity" });
    };
    const saved = f.path + ".saved";
    await rename(f.path, saved);
    await symlink(saved, f.path);
    await denied();
    await rm(f.path);
    await link(saved, f.path);
    await denied();
    await rm(f.path);
    await rename(saved, f.path);
    await writeFile(
      f.path,
      f.primary.bytes.subarray(0, f.primary.bytes.length - 1),
    );
    await denied();
  } finally {
    await http.close();
    await f.close();
  }
});

it("applies Workbench session, tab, same-origin and device gates before conditional GET", async () => {
  const f = await fixture();
  const http = await startWorkbenchHttp({
    session: new ProductionWorkbenchSession(null, undefined),
    access: workbenchTestAccess,
    assets: new Map([["/", { contentType: "text/html", body: "fixture" }]]),
    query: { application: f.query },
    devices: {
      service: f.app.deviceConnections,
      routes: deviceBusinessRoutes(f.app, f.query),
    },
  });
  try {
    const target = http.origin + f.primary.url;
    const conditional = { "If-None-Match": `"${f.primary.asset.sha256}"` };
    const anon = await fetch(target, { headers: conditional });
    expect(anon.status).toBe(401);
    expect(anon.headers.get("cache-control")).toBe("no-store");
    const auth = await workbenchLogin(http.origin);
    const landing = await fetch(http.origin, { headers: { Cookie: auth } });
    expect(landing.status).toBe(200);
    const workbenchCookies = landing.headers
      .getSetCookie()
      .map((value) => value.split(";")[0]!);
    const cookie = [auth, ...workbenchCookies].join("; ");
    const attached = await fetch(http.origin + "/api/clients", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: http.origin,
        "Content-Type": "application/json",
        "X-Workbench-Init": "1",
      },
      body: "{}",
    });
    expect(attached.status).toBe(201);
    const { client_id } = (await attached.json()) as { client_id: string };
    const grantHeaders = { Cookie: cookie, [clientHeader]: client_id };
    const fullAccess = await fetch(target, {
      headers: { ...grantHeaders, Range: "bytes=0-3" },
    });
    expect(fullAccess.status).toBe(206);
    headers(fullAccess, f.primary);
    expect(await bytes(fullAccess)).toEqual(f.primary.bytes.subarray(0, 4));
    const sameOrigin = await fetch(target, {
      headers: { ...conditional, ...grantHeaders, Origin: http.origin },
    });
    expect(sameOrigin.status).toBe(304);
    headers(sameOrigin, f.primary);
    expect(await sameOrigin.text()).toBe("");
    const legacyTarget = target + "?client_id=" + encodeURIComponent(client_id);
    for (const queried of [
      legacyTarget,
      target + "?limit=1",
      target + "?other=",
    ]) {
      const reply = await fetch(queried, {
        headers: { ...conditional, ...grantHeaders },
      });
      expect(reply.status).toBe(400);
      expect(await reply.json()).toEqual({ code: "invalid-query" });
    }
    const urlOnly = await fetch(legacyTarget, { headers: { Cookie: cookie } });
    expect(urlOnly.status).toBe(400);
    expect(await urlOnly.json()).toEqual({ code: "invalid-query" });

    const anotherAuth = await workbenchLogin(http.origin);
    const anotherSession = [anotherAuth, ...workbenchCookies].join("; ");
    for (const invalidGrant of [
      { Cookie: cookie },
      { Cookie: cookie, [clientHeader]: "" },
      { Cookie: anotherSession, [clientHeader]: client_id },
    ]) {
      const denied = await fetch(target, {
        headers: { ...conditional, ...invalidGrant },
      });
      expect(denied.status).toBe(401);
      expect(denied.headers.get("cache-control")).toBe("no-store");
      expect(await denied.json()).toEqual({ code: "client-required" });
    }
    const duplicate = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = httpRequest(
        target,
        {
          headers: {
            ...conditional,
            Cookie: cookie,
            [clientHeader]: [client_id, client_id],
          },
        },
        resolve,
      );
      request.on("error", reject);
      request.end();
    });
    let duplicateBody = "";
    for await (const chunk of duplicate) duplicateBody += String(chunk);
    expect(duplicate.statusCode).toBe(401);
    expect(duplicate.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(duplicateBody)).toEqual({ code: "client-required" });
    const noWorkbenchCookie = await fetch(target, {
      headers: { ...conditional, ...grantHeaders, Cookie: auth },
    });
    expect(noWorkbenchCookie.status).toBe(401);
    expect(await noWorkbenchCookie.json()).toEqual({
      code: "authentication-required",
    });
    const viewWithoutQuery = await fetch(http.origin + "/api/view", {
      headers: grantHeaders,
    });
    expect(viewWithoutQuery.status).toBe(401);
    expect(await viewWithoutQuery.json()).toEqual({ code: "client-required" });

    for (const [header, value] of [
      ["Origin", "https://foreign.example"],
      ["Sec-Fetch-Site", "cross-site"],
    ] as const) {
      const denied = await fetch(target, {
        headers: {
          ...conditional,
          ...grantHeaders,
          [header]: value,
        },
      });
      expect(denied.status).toBe(403);
      expect(denied.headers.get("cache-control")).toBe("no-store");
    }
    const pairing = await f.app.deviceConnections.create({
      address: http.origin,
      name: "Fixture reader",
      purposes: ["read"],
    });
    const { pairing_code } = parseDeviceConnectionCode(pairing.connection_code);
    const { token } = await f.app.deviceConnections.exchange(
      { pairing_code },
      "127.0.0.1",
    );
    const device = await fetch(target, {
      headers: {
        ...conditional,
        ...grantHeaders,
        Authorization: `Bearer ${token}`,
      },
    });
    expect(device.status).toBe(403);
    expect(await device.json()).toMatchObject({
      code: "device-purpose-forbidden",
    });
    const invalidDevice = await fetch(legacyTarget, {
      headers: {
        ...conditional,
        Cookie: cookie,
        Authorization: "Bearer invalid",
      },
    });
    expect(invalidDevice.status).toBe(400);
    expect(await invalidDevice.json()).toMatchObject({
      code: "device-token-in-url",
    });
  } finally {
    await http.close();
    await f.close();
  }
});

/** Observe a real reader after a chunk reaches the HTTP consumer. */
function afterFirstChunk(
  service: DocumentReadService,
  action: (signal: AbortSignal) => Promise<void>,
) {
  const read = service.withMaterialFile.bind(service);
  return vi
    .spyOn(service, "withMaterialFile")
    .mockImplementation((selected, consume, signal) =>
      read(
        selected,
        (material, chunks) =>
          consume(material, async function* (start, length) {
            let first = true;
            for await (const chunk of chunks(start, length)) {
              yield chunk;
              if (first) {
                first = false;
                await action(signal!);
              }
            }
          }),
        signal,
      ),
    );
}

it("cancels a ranged read on disconnect and releases the file scope", async () => {
  const f = await fixture(2 * chunkSize);
  const spy = afterFirstChunk(f.query.documentRead!, async (signal) => {
    if (!signal.aborted) await once(signal, "abort");
  });
  const http = await startQueryOnlyHttp({ application: f.query });
  const abort = new AbortController();
  try {
    const response = await fetch(http.origin + f.primary.url, {
      headers: { Range: `bytes=20-${2 * chunkSize}` },
      signal: abort.signal,
    });
    expect(response.status).toBe(206);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    abort.abort();
    await expect(spy.mock.results[0]!.value).rejects.toMatchObject({
      code: "document-cancelled",
    });
    spy.mockRestore();
    const fresh = await fetch(http.origin + f.primary.url, {
      headers: { Range: "bytes=0-3" },
    });
    expect(fresh.status).toBe(206);
    expect(await bytes(fresh)).toEqual(f.primary.bytes.subarray(0, 4));
  } finally {
    abort.abort();
    spy.mockRestore();
    await http.close();
    await f.close();
  }
});

it("interrupts a whole response on modification and rejects a same-size digest mismatch", async () => {
  const f = await fixture(2 * chunkSize);
  const spy = afterFirstChunk(f.query.documentRead!, async () => {
    const file = await open(f.path, "r+");
    try {
      await file.write(Buffer.from([1]), 0, 1, f.primary.bytes.length - 1);
    } finally {
      await file.close();
    }
  });
  const http = await startQueryOnlyHttp({ application: f.query });
  try {
    const url = http.origin + f.primary.url;
    const changed = await fetch(url);
    expect(changed.status).toBe(200);
    await expect(changed.arrayBuffer()).rejects.toThrow();
    await expect(spy.mock.results[0]!.value).rejects.toMatchObject({
      code: "document-integrity",
    });
    spy.mockRestore();
    // A range does no whole-file scan. The intact prefix is still available.
    const prefix = await fetch(url, { headers: { Range: "bytes=0-7" } });
    expect(prefix.status).toBe(206);
    expect(await bytes(prefix)).toEqual(f.primary.bytes.subarray(0, 8));
    const corrupt = await fetch(url);
    expect(corrupt.status).toBe(200);
    await expect(corrupt.arrayBuffer()).rejects.toThrow();
  } finally {
    spy.mockRestore();
    await http.close();
    await f.close();
  }
});
