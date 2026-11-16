import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Checkbox,
  DataTable,
  Dialog,
  ErrorNotice,
  Section,
  TextField,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { ApiError, type ApiClient } from "../../data/api.js";
import {
  agentBrief,
  DEVICE_DEFAULTS,
  DEVICE_PURPOSES,
  DEVICE_STATES,
  deviceState,
  libraryAddress,
  PURPOSE_DESCRIPTIONS,
  PURPOSE_LABELS,
  readDevice,
  readPairing,
  sortDevices,
  type DeviceConnection,
  type DeviceKind,
  type DevicePurpose,
  type Pairing,
} from "../../data/devices.js";
import { copyText } from "../../../browser-platform.js";
import { errorMessage, localTime } from "../../strings.js";

export const devicesKey = ["device-connections"] as const;

const DOWNLOADS = {
  extension: {
    label: "下载扩展安装包",
    description: "Chrome、Edge 用，在扩展管理页以开发者模式加载。",
    path: "/api/v1/intake/extension",
    file: "sciretriever-browser-extension.zip",
    missing: "扩展安装包尚未构建",
  },
  skill: {
    label: "下载 skill",
    description: "给 Agent 用的文献库使用说明。",
    path: "/api/v1/intake/skill",
    file: "sciretriever-skill.zip",
    missing: "skill 包尚未构建",
  },
} as const;
export type Download = keyof typeof DOWNLOADS;
/**
 * A package the library builds, saved as a file. Resolves to what to say
 * beside its button: empty once saved, or why it was not.
 */
export async function downloadPackage(
  api: ApiClient,
  kind: Download,
): Promise<string> {
  const { path, file, missing } = DOWNLOADS[kind];
  try {
    const response = await api.fetch(path);
    if (!response.ok) await api.json(response);
    const url = URL.createObjectURL(await response.blob()),
      link = document.createElement("a");
    link.href = url;
    link.download = file;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return "";
  } catch (error) {
    return error instanceof ApiError &&
      error.code === "device-artifact-unavailable"
      ? missing
      : errorMessage(error);
  }
}

/** Every connection, following the owner's cursor until the last page. */
export function useDevices() {
  const api = useApi();
  return useQuery({
    queryKey: devicesKey,
    queryFn: async ({ signal }) => {
      const devices: DeviceConnection[] = [];
      let cursor: string | null = null;
      do {
        const page = await api.call(
          "/api/v1/device-connections",
          { cursor },
          signal,
        );
        devices.push(
          ...(Array.isArray(page.items) ? page.items : []).map(readDevice),
        );
        cursor = typeof page.next_cursor === "string" ? page.next_cursor : null;
      } while (cursor);
      return sortDevices(devices);
    },
    // A code handed over in the last ten minutes may pair at any moment.
    refetchInterval: (query) =>
      query.state.data?.some(
        (device) =>
          deviceState(device) === "pending" &&
          Date.now() - new Date(device.created_at).getTime() < 600_000,
      )
        ? 3000
        : false,
  });
}

export function DeviceConnections() {
  const api = useApi(),
    queries = useQueryClient(),
    devices = useDevices();
  const [connecting, setConnecting] = useState<DeviceKind | null>(null),
    [renaming, setRenaming] = useState<DeviceConnection | null>(null),
    [notes, setNotes] = useState<Record<string, string>>({});
  const revoke = useMutation({
    mutationFn: (device: DeviceConnection) =>
      api.call("/api/v1/device-connections/revoke", {
        connection_id: device.connection_id,
      }),
    onSettled: () => void queries.invalidateQueries({ queryKey: devicesKey }),
  });
  /** A package the library builds; a missing build says so instead of failing. */
  const download = async (kind: Download) => {
    setNotes((current) => ({ ...current, [kind]: "" }));
    const note = await downloadPackage(api, kind);
    setNotes((current) => ({ ...current, [kind]: note }));
  };
  return (
    <>
      <Section
        title="设备连接"
        action={
          <div className="settings-device-actions">
            <Button onPress={() => setConnecting("extension")}>
              连接浏览器扩展
            </Button>
            <Button onPress={() => setConnecting("agent")}>连接 Agent</Button>
          </div>
        }
      >
        {devices.isError ? (
          <ErrorNotice
            message={errorMessage(devices.error)}
            onRetry={() => void devices.refetch()}
          />
        ) : (
          <DataTable
            label="设备连接"
            rows={devices.data ?? []}
            getRowId={(device) => device.connection_id}
            empty={
              devices.isPending
                ? "正在读取设备连接…"
                : "还没有连接设备。连接浏览器扩展或 Agent 后，它们在这里列出。"
            }
            columns={[
              {
                id: "name",
                header: "名称",
                value: (device) => device.name,
              },
              {
                id: "purposes",
                header: "用途",
                value: (device) =>
                  device.purposes
                    .map((purpose) => PURPOSE_LABELS[purpose])
                    .join(" · "),
                sortable: false,
              },
              {
                id: "created",
                header: "连接于",
                value: (device) => device.created_at,
                render: (device) => localTime(device.created_at),
              },
              {
                id: "used",
                header: "最近使用",
                value: (device) => device.last_used_at,
                render: (device) =>
                  device.last_used_at ? localTime(device.last_used_at) : "—",
              },
              {
                id: "state",
                header: "状态",
                value: (device) => DEVICE_STATES[deviceState(device)],
                render: (device) => (
                  <span
                    className="settings-device-state"
                    data-state={deviceState(device)}
                  >
                    {DEVICE_STATES[deviceState(device)]}
                  </span>
                ),
              },
              {
                id: "actions",
                header: "操作",
                value: () => null,
                sortable: false,
                render: (device) =>
                  device.revoked_at ? null : (
                    <div className="settings-device-row-actions">
                      <Button
                        size="compact"
                        onPress={() => setRenaming(device)}
                      >
                        改名
                      </Button>
                      <Button
                        size="compact"
                        variant="danger"
                        confirm={{
                          title: "撤销设备连接",
                          description:
                            "该设备的请求会立即被拒绝，要再连接需重新生成连接码。",
                          scope: device.name,
                          confirmLabel: "撤销",
                        }}
                        onPress={async () => {
                          await revoke.mutateAsync(device);
                        }}
                      >
                        撤销
                      </Button>
                    </div>
                  ),
              },
            ]}
          />
        )}
        {(Object.keys(DOWNLOADS) as Download[]).map((kind) => (
          <div key={kind} className="settings-device-skill">
            <Button size="compact" onPress={() => download(kind)}>
              {DOWNLOADS[kind].label}
            </Button>
            <span className="ui-description">
              {notes[kind] || DOWNLOADS[kind].description}
            </span>
          </div>
        ))}
      </Section>
      {connecting ? (
        <ConnectDialog kind={connecting} onClose={() => setConnecting(null)} />
      ) : null}
      {renaming ? (
        <RenameDialog device={renaming} onClose={() => setRenaming(null)} />
      ) : null}
    </>
  );
}

function ConnectDialog({
  kind,
  onClose,
}: {
  kind: DeviceKind;
  onClose: () => void;
}) {
  const api = useApi(),
    queries = useQueryClient();
  const [name, setName] = useState(DEVICE_DEFAULTS[kind].name),
    [purposes, setPurposes] = useState<DevicePurpose[]>(
      DEVICE_DEFAULTS[kind].purposes,
    ),
    // The code is handed over once and lives only in this dialog's state.
    [pairing, setPairing] = useState<Pairing | null>(null);
  const create = useMutation({
    mutationFn: async () =>
      readPairing(
        await api.call("/api/v1/device-connections/pairings", {
          address: libraryAddress(),
          name: name.trim(),
          // Which button made it: shown as “扩展” or “Agent”, never admission.
          kind,
          purposes: DEVICE_PURPOSES.filter((purpose) =>
            purposes.includes(purpose),
          ),
        }),
      ),
    onSuccess: (value) => {
      setPairing(value);
      void queries.invalidateQueries({ queryKey: devicesKey });
    },
  });
  const title = kind === "agent" ? "连接 Agent" : "连接浏览器扩展";
  return (
    <Dialog
      title={title}
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable={!create.isPending}
      className="settings-device-dialog"
      footer={
        pairing ? (
          <Button variant="primary" onPress={onClose}>
            完成
          </Button>
        ) : (
          <>
            <Button onPress={onClose} isDisabled={create.isPending}>
              取消
            </Button>
            <Button
              variant="primary"
              isPending={create.isPending}
              disabledReason={
                !name.trim()
                  ? "请填写名称"
                  : purposes.length === 0
                    ? "至少勾选一项用途"
                    : undefined
              }
              onPress={() => create.mutate()}
            >
              生成连接码
            </Button>
          </>
        )
      }
    >
      {pairing ? (
        <Handover kind={kind} pairing={pairing} />
      ) : (
        <div className="settings-device-form">
          <TextField
            label="名称"
            value={name}
            onChange={setName}
            maxLength={120}
            isRequired
          />
          <fieldset className="settings-device-purposes">
            <legend>用途</legend>
            {DEVICE_PURPOSES.map((purpose) => (
              <div key={purpose} className="settings-device-purpose">
                <Checkbox
                  label={PURPOSE_LABELS[purpose]}
                  isSelected={purposes.includes(purpose)}
                  onChange={(selected) =>
                    setPurposes((current) =>
                      selected
                        ? [...current, purpose]
                        : current.filter((item) => item !== purpose),
                    )
                  }
                />
                <p className="ui-description">
                  {PURPOSE_DESCRIPTIONS[purpose]}
                </p>
              </div>
            ))}
          </fieldset>
          {create.isError ? (
            <ErrorNotice message={errorMessage(create.error)} />
          ) : null}
        </div>
      )}
    </Dialog>
  );
}

function remaining(expires: string, now: number) {
  const seconds = Math.max(
    0,
    Math.floor((new Date(expires).getTime() - now) / 1000),
  );
  return seconds;
}

function Handover({ kind, pairing }: { kind: DeviceKind; pairing: Pairing }) {
  const [now, setNow] = useState(() => Date.now()),
    [copied, setCopied] = useState("");
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = remaining(pairing.expires_at, now),
    brief = agentBrief(pairing.connection_code, libraryAddress());
  const copy = async (what: string, text: string) => {
    try {
      await copyText(text);
      setCopied(what);
    } catch {
      setCopied("");
    }
  };
  return (
    <div className="settings-device-handover">
      <div className="settings-device-code">
        <code>{pairing.connection_code}</code>
        <Button
          size="compact"
          onPress={() => copy("code", pairing.connection_code)}
        >
          {copied === "code" ? "已复制" : "复制"}
        </Button>
      </div>
      <p className="ui-description" role="timer" aria-live="off">
        {left > 0
          ? `${Math.floor(left / 60)} 分 ${left % 60} 秒内有效，只能用一次`
          : "已过期，请重新生成"}
      </p>
      {kind === "agent" ? (
        <div className="settings-device-brief">
          <div>
            <h3>复制给 Agent 的话</h3>
            <Button size="compact" onPress={() => copy("brief", brief)}>
              {copied === "brief" ? "已复制" : "复制"}
            </Button>
          </div>
          <pre>{brief}</pre>
        </div>
      ) : (
        <p>把连接码粘贴到浏览器扩展的设置里。</p>
      )}
      <p className="ui-description">关闭后连接码不再显示；丢了就重新生成。</p>
    </div>
  );
}

function RenameDialog({
  device,
  onClose,
}: {
  device: DeviceConnection;
  onClose: () => void;
}) {
  const api = useApi(),
    queries = useQueryClient();
  const [name, setName] = useState(device.name);
  const rename = useMutation({
    mutationFn: () =>
      api.call("/api/v1/device-connections/rename", {
        connection_id: device.connection_id,
        name: name.trim(),
      }),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: devicesKey });
      onClose();
    },
  });
  return (
    <Dialog
      title="设备改名"
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        <>
          <Button onPress={onClose}>取消</Button>
          <Button
            variant="primary"
            isPending={rename.isPending}
            disabledReason={name.trim() ? undefined : "请填写名称"}
            onPress={() => rename.mutate()}
          >
            保存
          </Button>
        </>
      }
    >
      <TextField
        label="名称"
        value={name}
        onChange={setName}
        maxLength={120}
        isRequired
      />
      {rename.isError ? (
        <ErrorNotice message={errorMessage(rename.error)} />
      ) : null}
    </Dialog>
  );
}
