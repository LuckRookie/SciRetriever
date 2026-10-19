/** Authentication transport is shared by the independent login entry. */
export function loginDestination(search: string, origin: string): string {
  try {
    const next = new URL(
      new URLSearchParams(search).get("next") ?? "/",
      origin,
    );
    return next.origin === origin && next.pathname === "/"
      ? `${next.pathname}${next.search}`
      : "/";
  } catch {
    return "/";
  }
}
export async function loginStatus(signal: AbortSignal): Promise<boolean> {
  const response = await fetch("/auth/status", { signal });
  if (!response.ok) throw new Error("暂时无法确认登录状态。");
  const value: unknown = await response.json();
  return (
    !!value &&
    typeof value === "object" &&
    "authenticated" in value &&
    value.authenticated === true
  );
}
export async function signIn(
  password: string,
  signal: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workbench-Init": "1" },
      body: JSON.stringify({ password }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("无法连接服务器，请检查网络后重试。", { cause: error });
  }
  if (response.status === 401)
    throw new Error("密码或 API key 不正确，请重新输入。");
  if (response.status === 429)
    throw new Error("登录尝试过于频繁或会话已满，请稍后重试。");
  if (!response.ok) throw new Error("暂时无法登录，请刷新页面后重试。");
}
