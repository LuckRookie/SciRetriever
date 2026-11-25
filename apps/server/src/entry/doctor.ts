import {
  effectiveBrowserConcurrency,
  type BrowserConfig,
} from "../configuration/index.js";
import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import {
  CLOAK_VERSION,
  verifyInstalledCloakRuntime,
} from "../configuration/cloak-runtime.js";
import {
  MUPDF_MISSING_HINT,
  MUPDF_REMEDY,
  resolveMupdfRuntime,
} from "../proofread/mupdf.js";

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

/** A local part `sciretriever web` refuses to start without (ADR 0066 section 4). */
export interface StartupPart {
  readonly name: "mupdf" | "flock" | "prlimit";
  readonly ready: boolean;
  /** Where the part was found, or what is missing. */
  readonly detail: string;
  /** How to obtain it. */
  readonly remedy: string;
}
const UTIL_LINUX_REMEDY = "安装系统的 util-linux";
/**
 * The parts checked both by `doctor` and before `sciretriever web` opens a
 * catalog. Only parts the build already obtains, plus base-system commands.
 */
export async function startupParts(): Promise<readonly StartupPart[]> {
  const [flock, prlimit, mupdf] = await Promise.all([
    executable("flock"),
    executable("prlimit"),
    resolveMupdfRuntime(),
  ]);
  const command = (name: "flock" | "prlimit", path: string | null) =>
    Object.freeze({
      name,
      ready: path !== null,
      detail: path ?? `${name} is unavailable: ${UTIL_LINUX_REMEDY}`,
      remedy: UTIL_LINUX_REMEDY,
    });
  return Object.freeze([
    command("flock", flock),
    command("prlimit", prlimit),
    Object.freeze({
      name: "mupdf" as const,
      ready: mupdf !== undefined,
      detail: mupdf
        ? `${mupdf.version} (${mupdf.executable})`
        : `MuPDF bundle is unavailable: ${MUPDF_MISSING_HINT}`,
      remedy: MUPDF_REMEDY,
    }),
  ]);
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
    readonly browser?: BrowserConfig;
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
  const [parts, pdfinfo, xvfb] = await Promise.all([
    startupParts(),
    executable("pdfinfo"),
    executable("Xvfb"),
  ]);
  const part = (name: StartupPart["name"]): DoctorCheck => {
    const found = parts.find((item) => item.name === name)!;
    return Object.freeze({
      name,
      status: found.ready ? ("ready" as const) : ("blocked" as const),
      detail: found.detail,
    });
  };
  checks.push(
    part("flock"),
    part("prlimit"),
    check("pdfinfo", pdfinfo),
    check("Xvfb", xvfb),
    part("mupdf"),
  );
  if (options.browser) {
    const capacity = effectiveBrowserConcurrency(options.browser);
    checks.push(
      Object.freeze({
        name: "browser-capacity",
        status: "ready" as const,
        detail: `configured sessions=${capacity.configured_sessions}; effective sessions=${capacity.effective_sessions}; decision workers=${capacity.decision_workers}; restriction=${capacity.limiting_reason ?? "none"}`,
      }),
    );
  }
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
