import { expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setup, proposal, lit, id } from "./content-fixture.js";
import { parseLiterature } from "@sciretriever/contracts";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { WorkbenchSession } from "../src/workbench/session.js";
async function fixture() {
  const env = await setup();
  const session = new WorkbenchSession(
    lit,
    {
      id: "page",
      title: async () => "Fixture",
      url: () => "https://fixture.invalid",
      close: async () => {},
      snapshot: async () => ({
        url: "https://fixture.invalid",
        title: "Fixture",
        document_generation: 1,
        viewport: { width: 800, height: 600, device_scale_factor: 1 },
        screenshot: new Uint8Array([1]),
      }),
      apply: async () => {},
    },
    {
      max_actions: 10,
      max_model_calls: 2,
      max_retries: 2,
      max_bytes: 10000,
      deadline_ms: 60000,
    },
  );
  const http = await startWorkbenchHttp({
    session,
    assets: new Map([
      ["/", { contentType: "text/html", body: "<html></html>" }],
    ]),
    library: {
      queries: env.app.library,
      artifacts: env.app.literatureArtifacts,
    },
  });
  const root = await fetch(http.origin),
    cookie = root.headers.get("set-cookie")!.split(";")[0]!;
  const granted = await fetch(`${http.origin}/api/clients`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: http.origin,
      "X-Workbench-Init": "1",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  const grant = (await granted.json()) as { client_id: string; csrf: string };
  const path = (route: string) =>
    `${http.origin}/api/library/${route}?client_id=${grant.client_id}`;
  const headers = {
    Cookie: cookie,
    Origin: http.origin,
    "X-Workbench-Csrf": grant.csrf,
    "Content-Type": "application/json",
  };
  const post = (route: string, body: unknown) =>
    fetch(path(route), { method: "POST", headers, body: JSON.stringify(body) });
  return {
    ...env,
    http,
    headers,
    path,
    post,
    close: async () => {
      await http.close();
      await session.close();
      await env.close();
    },
  };
}
it("serves real paginated search, detail and references through the existing authenticated client boundary", async () => {
  const env = await fixture();
  try {
    for (let n = 0; n < 3; n++)
      await env.app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: id(80 + n),
          meta_literature_id: id(90 + n),
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title: `ZebraRecord ${n}`,
          },
        }),
      );
    const first = await env.post("search", {
      query: { text: "ZebraRecord" },
      limit: 2,
      sort: "title-asc",
    });
    expect(first.status).toBe(200);
    const page = (
      (await first.json()) as {
        page: { items: unknown[]; total_count: number; next_cursor: string };
      }
    ).page;
    expect(page.total_count).toBe(3);
    expect(page.items).toHaveLength(2);
    const second = await env.post("search", {
      query: { text: "ZebraRecord" },
      limit: 2,
      sort: "title-asc",
      cursor: page.next_cursor,
    });
    expect(
      ((await second.json()) as { page: { items: unknown[] } }).page.items,
    ).toHaveLength(1);
    const detail = await env.post("detail", { literature_id: lit });
    expect(await detail.json()).toEqual({
      detail: await env.app.library.detail(lit),
    });
    const bibliography = await env.post("bibliography", {
      literature_id: lit,
      format: "bibtex",
    });
    expect(bibliography.status).toBe(200);
    expect(bibliography.headers.get("content-disposition")).toContain(
      `${lit}.bib`,
    );
    expect(await bibliography.text()).toContain(
      "doi = {10.5555/sciretriever.fixture}",
    );
    const refs = await env.post("references", {
      literature_id: lit,
      direction: "references",
      limit: 10,
    });
    expect(refs.status).toBe(200);
    expect(await refs.json()).toEqual({
      page: await env.app.library.references({
        literature_id: lit,
        direction: "references",
        limit: 10,
      }),
    });
    expect((await env.post("detail", { literature_id: id(999) })).status).toBe(
      404,
    );
    expect(
      (await env.post("search", { query: { unexpected: true } })).status,
    ).toBe(409);
  } finally {
    await env.close();
  }
});
it("requires cookies, per-client CSRF and same origin even for library reads", async () => {
  const env = await fixture();
  try {
    const body = JSON.stringify({ literature_id: lit });
    expect(
      (
        await fetch(env.path("detail"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(env.path("detail"), {
          method: "POST",
          headers: { ...env.headers, "X-Workbench-Csrf": "wrong" },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(env.path("detail"), {
          method: "POST",
          headers: { ...env.headers, Origin: "https://attacker.invalid" },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await env.post("artifact", {
          literature_id: lit,
          kind: "primary-pdf",
          reference: "../catalog.sqlite",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await env.post("detail", {
          literature_id: lit,
          sql: "DELETE FROM assets",
        })
      ).status,
    ).toBe(409);
    expect((await env.app.library.detail(lit)).primary_pdf).not.toBeNull();
  } finally {
    await env.close();
  }
});
it("downloads only current verified PDF/Markdown as attachments and returns exact bytes", async () => {
  const env = await fixture();
  try {
    const p = await proposal(await env.app.library.detail(lit));
    await env.app.literatureContent.accept(p.value, p.bytes);
    const d = await env.app.library.detail(lit);
    for (const [kind, expected, extension] of [
      [
        "primary-pdf",
        await readFile(join(env.app.files.root, d.primary_pdf!.asset.path)),
        "pdf",
      ],
      ["content-markdown", p.bytes, "md"],
    ] as const) {
      const r = await env.post("artifact", { literature_id: lit, kind });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-disposition")).toBe(
        `attachment; filename="${lit}.${extension}"`,
      );
      expect(r.headers.get("content-length")).toBeNull();
      expect(Buffer.from(await r.arrayBuffer())).toEqual(Buffer.from(expected));
    }
  } finally {
    await env.close();
  }
});
it("refuses corrupted artifact bytes before sending a successful download", async () => {
  const env = await fixture();
  try {
    const d = await env.app.library.detail(lit);
    await writeFile(
      join(env.app.files.root, d.primary_pdf!.asset.path),
      "corrupt fixture bytes",
    );
    const r = await env.post("artifact", {
      literature_id: lit,
      kind: "primary-pdf",
    });
    expect(r.status).toBe(409);
    expect(r.headers.get("content-disposition")).toBeNull();
    expect(await r.text()).not.toContain("corrupt fixture bytes");
    expect(
      (
        await env.post("artifact", {
          literature_id: lit,
          kind: "content-markdown",
        })
      ).status,
    ).toBe(404);
  } finally {
    await env.close();
  }
});
