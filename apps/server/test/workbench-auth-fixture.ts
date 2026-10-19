import type { APIRequestContext } from "playwright";

/** Public synthetic credential, used only by isolated loopback regression servers. */
export const WORKBENCH_TEST_PASSWORD = "synthetic-workbench-test-password";
export const workbenchTestAccess = {
  host: "127.0.0.1",
  password: WORKBENCH_TEST_PASSWORD,
};

/** Exercise the real login route; never bypass the server's authentication boundary. */
export async function workbenchLogin(
  origin: string,
  password = WORKBENCH_TEST_PASSWORD,
): Promise<string> {
  const response = await fetch(`${origin}/auth/login`, {
    method: "POST",
    redirect: "error",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Workbench-Init": "1",
    },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) throw new Error(`Fixture login failed: ${response.status}`);
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0]!)
    .join("; ");
}

export async function loginWorkbenchPage(
  page: { request: APIRequestContext },
  origin: string,
  password = WORKBENCH_TEST_PASSWORD,
): Promise<void> {
  const response = await page.request.post(`${origin}/auth/login`, {
    headers: { Origin: origin, "X-Workbench-Init": "1" },
    data: { password },
  });
  if (!response.ok())
    throw new Error(`Fixture browser login failed: ${response.status()}`);
}
