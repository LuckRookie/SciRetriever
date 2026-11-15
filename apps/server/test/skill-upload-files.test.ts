import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const repository = resolve(new URL("../../..", import.meta.url).pathname);

it("runs the upload helper's offline HTTP regression suite", async () => {
  const result = await execute(
    "python3",
    [
      "-I",
      "-B",
      "-m",
      "unittest",
      "discover",
      "-s",
      "skills/sciretriever/tests",
      "-p",
      "test_*.py",
    ],
    { cwd: repository, timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  const count = /Ran (\d+) tests/u.exec(result.stderr);
  expect(Number(count?.[1])).toBeGreaterThan(0);
  expect(result.stderr).toMatch(/\bOK\b/u);
  expect(result.stdout).toBe("");
  console.info(`Upload helper: ${count![1]} offline Python tests passed.`);
}, 60_000);
