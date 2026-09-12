import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import {
  CLOAK_VERSION,
  verifyInstalledCloakRuntime,
} from "../configuration/cloak-runtime.js";

export interface DoctorCheck {
  readonly name: string;
  readonly status: "ready" | "blocked";
  readonly detail: string;
}

export interface DoctorReport {
  readonly schema_version: 1;
  readonly status: "ready" | "blocked";
  readonly platform: string;
  readonly architecture: string;
  readonly node_version: string;
  readonly checks: readonly DoctorCheck[];
}

async function executable(name: string): Promise<string | null> {
  for (const directory of (process.env.PATH ?? "/usr/bin:/bin")
    .split(delimiter)
    .filter((value) => value.startsWith("/"))) {
    const path = join(directory, name);
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.mode & 0o002) continue;
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Continue through the bounded PATH list.
    }
  }
  return null;
}

function check(name: string, value: string | null): DoctorCheck {
  return Object.freeze({
    name,
    status: value === null ? "blocked" : "ready",
    detail: value ?? `${name} is unavailable`,
  });
}

/** Read-only support check. It never launches a browser or performs network I/O. */
export async function runDoctor(
  options: {
    readonly cloakBundle?: string | null;
  } = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  checks.push(
    Object.freeze({
      name: "platform",
      status:
        process.platform === "linux" && process.arch === "x64"
          ? "ready"
          : "blocked",
      detail: `${process.platform}-${process.arch}`,
    }),
  );
  const [flock, prlimit, pdfinfo, pdftotext, xvfb] = await Promise.all([
    executable("flock"),
    executable("prlimit"),
    executable("pdfinfo"),
    executable("pdftotext"),
    executable("Xvfb"),
  ]);
  checks.push(
    check("flock", flock),
    check("prlimit", prlimit),
    check("pdfinfo", pdfinfo),
    check("pdftotext", pdftotext),
    check("Xvfb", xvfb),
  );
  const bundle = options.cloakBundle ?? process.env.SCIRETRIEVER_CLOAK_BUNDLE;
  if (!bundle)
    checks.push(
      Object.freeze({
        name: "cloakbrowser",
        status: "blocked",
        detail: `operator bundle ${CLOAK_VERSION} is not configured`,
      }),
    );
  else {
    try {
      const runtime = await verifyInstalledCloakRuntime(bundle);
      checks.push(
        Object.freeze({
          name: "cloakbrowser",
          status: "ready",
          detail: `${runtime.version} (${runtime.executablePath})`,
        }),
      );
    } catch {
      checks.push(
        Object.freeze({
          name: "cloakbrowser",
          status: "blocked",
          detail: "configured operator bundle failed verification",
        }),
      );
    }
  }
  return Object.freeze({
    schema_version: 1,
    status: checks.every((item) => item.status === "ready")
      ? "ready"
      : "blocked",
    platform: process.platform,
    architecture: process.arch,
    node_version: process.version,
    checks: Object.freeze(checks),
  });
}
