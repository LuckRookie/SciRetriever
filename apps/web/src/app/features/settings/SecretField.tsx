import { useRef, useState } from "react";
import { Button } from "../../components/index.js";
import { useApi } from "../../data/query.js";
import type { JsonRecord } from "../../data/wire.js";
import { errorMessage } from "../../strings.js";

/**
 * A key or token kept next to the service it belongs to (page specs “设置”).
 * It is saved through the credential interface, shows only “已保存” or “未填”,
 * and its value is cleared from the page as soon as it is sent.
 */
export function SecretField({
  label,
  saved,
  namespace,
  target,
  baseline,
  disabledReason,
  onResult,
}: {
  /** Names the password box, e.g. “openai 的密钥”. */
  label: string;
  saved: boolean;
  namespace: "model" | "mineru";
  target: string;
  baseline: string;
  disabledReason?: string | undefined;
  onResult: (result: JsonRecord) => void;
}) {
  const api = useApi();
  const [editing, setEditing] = useState(false),
    [pending, setPending] = useState(false),
    [message, setMessage] = useState("");
  const secret = useRef<HTMLInputElement>(null);
  const submit = async (edit: JsonRecord) => {
    setPending(true);
    try {
      onResult(
        await api.request("/api/configuration/credential", { edit, baseline }),
      );
      return true;
    } catch (error) {
      setMessage(
        `未保存：${errorMessage(error)}。值已从页面清除，请重新输入。`,
      );
      return false;
    } finally {
      setPending(false);
      if (secret.current) secret.current.value = "";
    }
  };
  const save = async () => {
    const value = secret.current?.value ?? "";
    if (secret.current) secret.current.value = "";
    if (!value) {
      setMessage("请填写后再保存。");
      return;
    }
    if (await submit({ namespace, target, kind: "set", value })) {
      setEditing(false);
      setMessage("已保存，下一次请求这个服务时生效。");
    }
  };
  if (!editing)
    return (
      <span className="settings-secret" data-saved={saved}>
        <span className="settings-secret-state">
          {saved ? "已保存" : "未填"}
        </span>
        <Button
          size="compact"
          disabledReason={disabledReason}
          onPress={() => {
            setMessage("");
            setEditing(true);
          }}
        >
          {saved ? "替换" : "填写"}
        </Button>
        {saved ? (
          <Button
            size="compact"
            variant="text"
            isDisabled={pending}
            confirm={{
              title: "清除密钥",
              description: "清除后，请求这个服务时不再带上密钥。",
              confirmLabel: "清除",
            }}
            onPress={async () => {
              if (await submit({ namespace, target, kind: "remove" }))
                setMessage("已清除。");
            }}
          >
            清除
          </Button>
        ) : null}
        {message ? <span role="status">{message}</span> : null}
      </span>
    );
  return (
    <span className="settings-secret">
      <span className="credential-field">
        <input
          ref={secret}
          className="ui-input"
          aria-label={label}
          type="password"
          autoComplete="new-password"
        />
      </span>
      <Button size="compact" isPending={pending} onPress={save}>
        保存
      </Button>
      <Button
        size="compact"
        variant="text"
        onPress={() => {
          if (secret.current) secret.current.value = "";
          setEditing(false);
          setMessage("");
        }}
      >
        取消
      </Button>
      {message ? <span role="status">{message}</span> : null}
    </span>
  );
}
