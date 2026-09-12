export type LogLevel = "debug" | "info" | "warn" | "error";
export interface SafeLogFields {
  readonly [key: string]: string | number | boolean | null | undefined;
}
export interface Logger {
  debug(message: string, fields?: SafeLogFields): void;
  info(message: string, fields?: SafeLogFields): void;
  warn(message: string, fields?: SafeLogFields): void;
  error(message: string, fields?: SafeLogFields): void;
}
const SECRET_KEY =
  /(?:authorization|api[_-]?key|access[_-]?token|bearer|cookie|password|secret|signature|token)/iu;
const SECRET_VALUE =
  /(?:bearer\s+|api[_-]?key\s*[:=]|access[_-]?token\s*[:=]|password\s*[:=]|secret\s*[:=])\S+/iu;
const SAFE_FIELD_NAMES = new Set([
  "provider",
  "model",
  "role",
  "operation",
  "endpoint",
  "status",
  "http_status",
  "code",
  "retryable",
  "bytes",
  "attempt",
]);
function safe(value: string): string {
  if (SECRET_VALUE.test(value)) return "[REDACTED]";
  return value
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/giu, "$1[REDACTED]@")
    .replace(
      /([?&](?:token|key|secret|signature|password|access_token|api_key)=)[^&]*/giu,
      "$1[REDACTED]",
    );
}
function fields(value: SafeLogFields | undefined): string {
  if (!value) return "";
  return Object.entries(value)
    .filter(([key]) => SAFE_FIELD_NAMES.has(key) && !SECRET_KEY.test(key))
    .map(
      ([key, item]) =>
        `${key}=${typeof item === "string" ? safe(item) : String(item)}`,
    )
    .join(" ");
}
export function createLogger(
  component: string,
  sink: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  minimum: LogLevel = "info",
): Logger {
  if (!component || /[\s\p{Cc}]/u.test(component))
    throw new Error("logging operation failed");
  const rank: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  };
  const write = (
    level: LogLevel,
    message: string,
    data?: SafeLogFields,
  ): void => {
    if (rank[level] < rank[minimum] || typeof message !== "string") return;
    const rendered = safe(message);
    const context = fields(data);
    sink(
      `${level.toUpperCase()} component=${component} ${rendered}${context ? ` ${context}` : ""}`,
    );
  };
  return {
    debug: (message, data) => write("debug", message, data),
    info: (message, data) => write("info", message, data),
    warn: (message, data) => write("warn", message, data),
    error: (message, data) => write("error", message, data),
  };
}
