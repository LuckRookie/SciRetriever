import { record, type JsonRecord } from "./wire.js";

export const DEVICE_PURPOSES = ["intake", "read", "operate"] as const;
export type DevicePurpose = (typeof DEVICE_PURPOSES)[number];
export const PURPOSE_LABELS: Record<DevicePurpose, string> = {
  intake: "入库",
  read: "读取",
  operate: "操作",
};
export const PURPOSE_DESCRIPTIONS: Record<DevicePurpose, string> = {
  intake:
    "收藏网页、从 Zotero 或文件入库；只新增，不删除、不替换；只能看到本设备发起的批次。",
  read: "经 MCP 查询与阅读文献库。",
  operate:
    "经 MCP 发起获取、加工等任务，包括会联网、会花费的获取、解析与模型调用。",
};
export const DEVICE_DEFAULTS: Record<
  DeviceKind,
  { name: string; purposes: DevicePurpose[] }
> = {
  extension: { name: "浏览器扩展", purposes: ["intake"] },
  agent: { name: "Agent", purposes: ["intake", "read"] },
};

export type DeviceKind = "extension" | "agent";
export interface DeviceConnection {
  connection_id: string;
  name: string;
  /** Which dialog made it; null for connections made before kinds existed. */
  kind: DeviceKind | null;
  purposes: DevicePurpose[];
  created_at: string;
  paired_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}
export type DeviceState = "connected" | "pending" | "revoked";
export const DEVICE_STATES: Record<DeviceState, string> = {
  connected: "已连接",
  pending: "待配对",
  revoked: "已撤销",
};
export const deviceState = (device: DeviceConnection): DeviceState =>
  device.revoked_at ? "revoked" : device.paired_at ? "connected" : "pending";

const time = (value: unknown) => (typeof value === "string" ? value : null);
export function readDevice(value: unknown): DeviceConnection {
  const item = record(value, "device connection");
  if (typeof item.connection_id !== "string" || typeof item.name !== "string")
    throw new Error("invalid device connection");
  return {
    connection_id: item.connection_id,
    name: item.name,
    kind: item.kind === "extension" || item.kind === "agent" ? item.kind : null,
    purposes: (Array.isArray(item.purposes) ? item.purposes : []).filter(
      (purpose): purpose is DevicePurpose =>
        (DEVICE_PURPOSES as readonly unknown[]).includes(purpose),
    ),
    created_at: time(item.created_at) ?? "",
    paired_at: time(item.paired_at),
    last_used_at: time(item.last_used_at),
    revoked_at: time(item.revoked_at),
  };
}
/** Connected first, then pending, then revoked; newest first within each. */
export function sortDevices(devices: DeviceConnection[]): DeviceConnection[] {
  const order: Record<DeviceState, number> = {
    connected: 0,
    pending: 1,
    revoked: 2,
  };
  return [...devices].sort(
    (a, b) =>
      order[deviceState(a)] - order[deviceState(b)] ||
      b.created_at.localeCompare(a.created_at),
  );
}

export interface Pairing {
  connection: DeviceConnection;
  expires_at: string;
  connection_code: string;
}
export function readPairing(value: JsonRecord): Pairing {
  if (
    typeof value.connection_code !== "string" ||
    typeof value.expires_at !== "string"
  )
    throw new Error("invalid pairing");
  return {
    connection: readDevice(value.connection),
    expires_at: value.expires_at,
    connection_code: value.connection_code,
  };
}
/** The page's own address with an explicit port, as the owner requires. */
export function libraryAddress(origin = location.origin): string {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
}

/** Text the user pastes to an Agent on their own computer (plan 20, block 06). */
export function agentBrief(code: string, address: string): string {
  return [
    "请连接我的 SciRetriever 文献库，之后按我的要求使用它。",
    "",
    `连接码：${code}`,
    "",
    `1. 换令牌：连接码的格式是 sr-connect1:<编码后的地址>:<配对码>，地址是 ${address}。10 分钟内、只能用一次，向 ${address}/api/v1/device-connections/exchange 发 POST，正文 {"pairing_code":"<配对码>"}。回复的 result.token 是令牌，只出现这一次。`,
    '2. 令牌不要打印、不要显示回复的任何部分，直接写进只有我能读的文件：在 ~/.config/sciretriever/（目录权限 700）写 address（文献库地址，不带换行）和 curl.conf（权限 600，三行：header = "Authorization: Bearer <令牌>"、header = "X-Sciretriever-Protocol-Version: 1"、noproxy = "*"；文献库必须经代理才能访问时去掉最后一行）。之后的请求都用 curl --config ~/.config/sciretriever/curl.conf 带上它们。',
    `3. 下载文献库自带的 skill：GET ${address}/api/v1/intake/skill（zip，解压后是 sciretriever/ 目录，放到你存放 skill 的位置，例如 Claude Code 的 ~/.claude/skills/），读 SKILL.md 后再开始；装不了 skill 时读 ${address}/api/v1/intake/agent-guide。`,
    "4. 连不上时告诉我所连的地址，提醒我检查端口映射是否开着。",
  ].join("\n");
}
