import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { CliOptions } from "./main.js";
import type { TypeScriptConfigurationOwner } from "../configuration/owner.js";

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

/** Small stdin/stdout configuration center owned by the TS configuration owner. */
export async function runConfigurationCenter(
  owner: TypeScriptConfigurationOwner,
  options: Pick<CliOptions, "stdout" | "stdin">,
): Promise<number> {
  const write = (value: string) => options.stdout?.(value);
  const status = await owner.status();
  write(
    "SciRetriever configuration center\nLocal status only · no network requests\n\n",
  );
  for (const [key, label] of AREAS) write(`  ${key.toUpperCase()}. ${label}\n`);
  if (!options.stdin) {
    write(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }
  const input = Readable.from(options.stdin);
  const lines = createInterface({ input });
  for await (const line of lines) {
    const key = line.trim().toLowerCase();
    const area = AREAS.find(([shortcut]) => shortcut === key);
    if (!area) {
      write("Choose M/S/D/P/A/B/I/T/Q.\n");
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
