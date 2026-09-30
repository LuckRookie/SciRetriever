import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { CliOptions } from "./main.js";
import type { TypeScriptConfigurationOwner } from "../configuration/owner.js";
import { ConfigurationProbeSession } from "../configuration/owner.js";
import { renderPlainHome, runRichConfigurationCenter } from "./config-ui.js";
import type { ConfigTheme } from "./config-ui.js";

const AREAS = [
  ["m", "Models"],
  ["s", "Search"],
  ["d", "Download"],
  ["p", "Parse"],
  ["a", "Analyze"],
  ["b", "Browser"],
  ["i", "Status"],
  ["t", "Theme"],
  ["q", "Quit"],
] as const;

/**
 * Route the interactive Rich-style center and deterministic redirected
 * fallback. The plain result pages stay on stdout; interactive prompts,
 * invalid selections and diagnostics go to stderr.
 */
export async function runConfigurationCenter(
  owner: TypeScriptConfigurationOwner,
  options: Pick<CliOptions, "stdout" | "stderr" | "stdin"> & {
    readonly theme?: ConfigTheme;
    readonly probeSeams?: CliOptions["probeSeams"];
  },
): Promise<number> {
  // Plain, deterministic result pages are the non-TTY result: stdout.
  const write = (value: string) => options.stdout?.(value);
  // Interactive hints and diagnostics never mix into the result stream.
  const diagnose = (value: string) => {
    const sink =
      options.stderr ?? ((text: string) => process.stderr.write(text));
    sink(value);
  };
  const processStdin =
    options.stdin !== undefined && options.stdin === process.stdin;
  if (
    process.stdin.isTTY &&
    process.stderr.isTTY &&
    (options.stdin === undefined || processStdin)
  ) {
    return await runRichConfigurationCenter({
      owner,
      probeFactory: () =>
        ConfigurationProbeSession.create(owner, options.probeSeams ?? {}),
      ...(options.theme === undefined ? {} : { theme: options.theme }),
      write: (text) =>
        (options.stderr ?? ((value: string) => process.stderr.write(value)))(
          text,
        ),
    });
  }

  const snapshot = await owner.read();
  const status = await owner.status();
  write(`${renderPlainHome(snapshot.configuration, status)}\n\n`);
  for (const [key, label] of AREAS) write(`  ${key.toUpperCase()}. ${label}\n`);
  if (options.stdin === undefined || processStdin) {
    return 0;
  }
  const input = Readable.from(options.stdin);
  const lines = createInterface({ input });
  for await (const line of lines) {
    const key = line.trim().toLowerCase();
    const area = AREAS.find(([shortcut]) => shortcut === key);
    if (!area) {
      diagnose("Choose M/S/D/P/A/B/I/T/Q.\n");
      continue;
    }
    if (area[0] === "q") break;
    if (area[0] === "i") {
      write(`${JSON.stringify(await owner.status(), null, 2)}\n`);
      continue;
    }
    write(`${area[1]} is managed by the TypeScript configuration owner.\n`);
  }
  lines.close();
  return 0;
}
