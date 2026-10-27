import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, expect, it } from "vitest";
import { RestartAdmission } from "../src/application/restart-admission.js";
import { startProductionWorkbench } from "../src/bootstrap/workbench.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";
beforeAll(async () => {
  await promisify(execFile)("pnpm", ["exec", "tsc", "-b"], {
    cwd: resolve("."),
    timeout: 90000,
  });
}, 120000);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-restart-admission-"));
  await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
  return { home, catalog: join(home, "catalog.sqlite") };
}
it("intent covers registration; registered continuations drain while later work is refused; activity covers settling", async () => {
  const { home, catalog } = await fixture(),
    admission = new RestartAdmission(home, catalog),
    entered = deferred(),
    finish = deferred();
  let registered = false;
  const registration = admission.newWork(async () => {
    entered.resolve();
    await finish.promise;
    registered = true;
  });
  try {
    await entered.promise;
    const registrationIntent = await admission.acquire("intent", "exclusive");
    await expect(
      admission.acquire("activity", "exclusive"),
    ).rejects.toMatchObject({ code: "configuration-apply-busy" });
    await registrationIntent.release();
    finish.resolve();
    await registration;
    expect(registered).toBe(true);
    const intent = await admission.acquire("intent", "exclusive");
    try {
      await expect(
        admission.newWork(async () => {
          throw new Error("not reached");
        }),
      ).rejects.toMatchObject({ code: "configuration-apply-busy" });
      const settle = deferred(),
        started = deferred();
      const continuation = admission.continuation(async () => {
        started.resolve();
        await settle.promise;
      });
      await started.promise;
      await expect(
        admission.acquire("activity", "exclusive"),
      ).rejects.toMatchObject({ code: "configuration-apply-busy" });
      settle.resolve();
      await continuation;
      const activity = await admission.acquire("activity", "exclusive");
      await activity.release();
    } finally {
      await intent.release();
    }
  } finally {
    finish.resolve();
    await registration;
    await rm(home, { recursive: true, force: true });
  }
});
it("background probes hold activity before their acceptance receipt and cannot reuse an expired outer scope", async () => {
  const { home, catalog } = await fixture(),
    admission = new RestartAdmission(home, catalog),
    finish = deferred();
  let late!: () => Promise<void>;
  try {
    await admission.newWork(async () => {
      late = () => admission.newWork(async () => {});
    });
    // Explicit retained closures get a new admission; detached asynchronous chains cannot inherit a dead permit.
    const gate = await admission.acquire("intent", "exclusive");
    await expect(late()).rejects.toMatchObject({
      code: "configuration-apply-busy",
    });
    await gate.release();
    const background = await admission.newWork(() =>
      admission.background(() => finish.promise),
    );
    const intent = await admission.acquire("intent", "exclusive");
    try {
      await expect(
        admission.acquire("activity", "exclusive"),
      ).rejects.toMatchObject({ code: "configuration-apply-busy" });
      finish.resolve();
      await background.promise;
      const activity = await admission.acquire("activity", "exclusive");
      await activity.release();
    } finally {
      await intent.release();
    }
  } finally {
    finish.resolve();
    await rm(home, { recursive: true, force: true });
  }
});
it("blocks another product process at bootstrap, including a different home pointing to the same catalog", async () => {
  const { home, catalog } = await fixture(),
    other = await mkdtemp(join(tmpdir(), "sciretriever-other-home-")),
    admission = new RestartAdmission(home, catalog);
  const gate = await admission.acquire("intent", "exclusive");
  try {
    const module = pathToFileURL(
      resolve("apps/server/dist/bootstrap/application.js"),
    ).href;
    await mkdir(join(other, ".sciretriever"), { mode: 0o700 });
    await writeFile(
      join(other, ".sciretriever", "config.toml"),
      `[paths]\ncatalog_path=${JSON.stringify(catalog)}\n`,
      { mode: 0o600 },
    );
    const code = `import {createApplication} from ${JSON.stringify(module)};try{const app=await createApplication(${JSON.stringify(other)},{afterStage:async()=>{process.stdout.write('unsafe');}});await app.close();}catch(e){process.stdout.write(e.code);}`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    let output = "",
      errors = "";
    child.stdout.on("data", (b) => {
      output += String(b);
    });
    child.stderr.on("data", (b) => {
      errors += String(b);
    });
    const exit = await new Promise<number | null>((done) =>
      child.once("exit", done),
    );
    expect(exit).toBe(0);
    expect(errors).toBe("");
    expect(output).toBe("configuration-apply-busy");
  } finally {
    await gate.release();
    await rm(home, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

it("publishes initialized sentinels before concurrent first use", async () => {
  const { home, catalog } = await fixture();
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, async () => {
        const lease = await new RestartAdmission(home, catalog).acquire(
          "intent",
          "shared",
        );
        await lease.release();
      }),
    );
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    for (const result of results)
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({
          code: "configuration-apply-busy",
        });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("does not lend an active bootstrap permit to an authenticated HTTP request", async () => {
  const { home } = await fixture(),
    gate = new RestartAdmission(
      home,
      join(home, ".sciretriever/catalog.sqlite"),
    ),
    entered = deferred(),
    finish = deferred();
  let web: Awaited<ReturnType<typeof startProductionWorkbench>> | undefined;
  const boot = gate.newWork(async () => {
    web = await startProductionWorkbench({
      home,
      port: 0,
      access: workbenchTestAccess,
      assets: new Map([
        ["/", { contentType: "text/html", body: "Synthetic active bootstrap" }],
      ]),
    });
    entered.resolve();
    await finish.promise;
  });
  let intent: Awaited<ReturnType<RestartAdmission["acquire"]>> | undefined;
  try {
    await Promise.race([entered.promise, boot]);
    intent = await gate.acquire("intent", "exclusive");
    const origin = web!.origin,
      auth = await workbenchLogin(origin),
      root = await fetch(origin, { headers: { Cookie: auth } }),
      cookie = `${auth}; ${root.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ")}`;
    const registered = await fetch(`${origin}/api/clients`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "X-Workbench-Init": "1",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const grant = (await registered.json()) as {
      client_id: string;
      csrf: string;
    };
    const read = await fetch(
        `${origin}/api/configuration/sources?client_id=${grant.client_id}`,
        { headers: { Cookie: cookie } },
      ),
      directory = (await read.json()) as {
        result: { catalog_revision: string };
      };
    const response = await fetch(
      `${origin}/api/configuration/source-save?client_id=${grant.client_id}`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
          "X-Workbench-Csrf": grant.csrf,
        },
        body: JSON.stringify({
          source: "sci-hub",
          baseline: directory.result.catalog_revision,
          parameters: { action: "keep" },
          credentials: [],
          test_after_save: false,
        }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "configuration-apply-busy",
    });
  } finally {
    await intent?.release();
    finish.resolve();
    await boot;
    await web?.close();
    await rm(home, { recursive: true, force: true });
  }
});
