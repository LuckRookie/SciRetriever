/**
 * Settings sections, by the thing a person comes to do (page specs “设置”):
 * appearance first, the library files and maintenance last.
 */
export const SETTINGS_SECTIONS = [
  { id: "appearance", label: "外观" },
  { id: "models", label: "模型服务" },
  { id: "acquire", label: "获取 PDF" },
  { id: "fulltext", label: "解析全文" },
  { id: "devices", label: "设备连接" },
  { id: "network", label: "网络" },
  { id: "paths", label: "文献库文件" },
  { id: "status", label: "运行状态" },
  { id: "advanced", label: "高级" },
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

/**
 * Where an address of an earlier section lands: the source directory moved
 * into “获取 PDF”, parsing and the archive parameters into “解析全文”, and
 * the credentials next to the services they belong to.
 */
const FORMER: Readonly<Record<string, SettingsSection>> = {
  sources: "acquire",
  parser: "fulltext",
  archive: "fulltext",
  cred: "models",
  credentials: "models",
};

/** The section an address opens, among those this kind of workspace offers. */
export function settingsSection(
  value: string | null | undefined,
  offered: readonly string[],
): string {
  const id = value ? (FORMER[value] ?? value) : null;
  return id && offered.includes(id) ? id : (offered[0] ?? "appearance");
}
