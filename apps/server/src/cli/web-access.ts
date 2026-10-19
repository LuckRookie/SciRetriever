import {
  WorkbenchAccessError,
  validateWorkbenchAccess,
  type WorkbenchAccessOptions,
} from "../workbench/access.js";

export function parseWebOptions(args: readonly string[]): {
  port: number;
  access: Omit<WorkbenchAccessOptions, "password">;
} {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (!["--port", "--host"].includes(flag) || !value || values.has(flag))
      throw new WorkbenchAccessError("web-access-invalid");
    values.set(flag, value);
  }
  const rawPort = values.get("--port") ?? "4174";
  const port = Number(rawPort);
  if (
    !/^\d+$/u.test(rawPort) ||
    !Number.isSafeInteger(port) ||
    port < 0 ||
    port > 65535
  )
    throw new WorkbenchAccessError("web-access-invalid");
  const access = { host: values.get("--host") ?? "0.0.0.0" };
  validateWorkbenchAccess(access);
  return { port, access };
}

export function webAccessOptions(
  access: Omit<WorkbenchAccessOptions, "password">,
): WorkbenchAccessOptions {
  const password = process.env.SCIRETRIEVER_WEB_PASSWORD;
  // Never pass the login credential to subsequently spawned Agent processes.
  delete process.env.SCIRETRIEVER_WEB_PASSWORD;
  const result = { ...access, ...(password === undefined ? {} : { password }) };
  validateWorkbenchAccess(result);
  return result;
}
