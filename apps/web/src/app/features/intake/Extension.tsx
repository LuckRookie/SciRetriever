import { useState } from "react";
import { Button } from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { navigate } from "../../data/url.js";
import { deviceState, type DeviceConnection } from "../../data/devices.js";
import { downloadPackage, useDevices } from "../settings/Devices.js";
import { copyText } from "../../../browser-platform.js";

/**
 * The extensions that bring papers in (page specs “入库 · Zotero”): made as
 * an extension, paired, not revoked, allowed to take in papers. A connection
 * from before kinds existed is not counted as one.
 */
export function linkedExtensions(devices: readonly DeviceConnection[]) {
  return devices.filter(
    (device) =>
      device.kind === "extension" &&
      deviceState(device) === "connected" &&
      device.purposes.includes("intake"),
  );
}
function ConnectionLine({ devices }: { devices: DeviceConnection[] | null }) {
  const linked = linkedExtensions(devices ?? []);
  return (
    <p className="intake-extension-state" role="status">
      {devices === null
        ? "正在读取设备连接…"
        : linked.length
          ? `已连接扩展 · ${linked.map((device) => device.name).join("、")}`
          : "没有连接扩展"}
    </p>
  );
}
const openDevices = () => navigate({ view: "set", setting: "devices" });

/** Three steps to connect the extension, each with its own way to act. */
function ConnectSteps() {
  const api = useApi();
  const [note, setNote] = useState(""),
    [copied, setCopied] = useState(false);
  return (
    <ol className="intake-extension-steps">
      <li>
        <span>在“设置 · 设备连接”下载扩展安装包。</span>
        <Button
          size="compact"
          onPress={async () => setNote(await downloadPackage(api, "extension"))}
        >
          下载扩展安装包
        </Button>
        {note ? <span className="ui-description">{note}</span> : null}
      </li>
      <li>
        <span>在浏览器的扩展页面以开发者模式加载。</span>
        <Button
          size="compact"
          onPress={async () => {
            await copyText("chrome://extensions");
            setCopied(true);
          }}
        >
          {copied ? "已复制扩展页面地址" : "复制扩展页面地址"}
        </Button>
      </li>
      <li>
        <span>在设置页生成连接码，粘贴到扩展里。</span>
        <Button size="compact" onPress={openDevices}>
          前往设备连接
        </Button>
      </li>
    </ol>
  );
}

/** “Zotero”: the libraries and groups are chosen in the extension. */
export function ZoteroIntake() {
  const devices = useDevices();
  const list = devices.data ?? (devices.isError ? [] : null);
  return (
    <div className="intake-extension">
      <ConnectionLine devices={list} />
      {list === null ? null : linkedExtensions(list).length ? (
        <p>
          在扩展里选择要导入的库和分组。导入开始后，这里的批次记录会出现这一批。
        </p>
      ) : (
        <ConnectSteps />
      )}
    </div>
  );
}

/** “网页”: a paper's page is saved from the extension's toolbar button. */
export function WebIntake() {
  const devices = useDevices();
  return (
    <div className="intake-extension">
      <p>在出版社或预印本的文献页面上，点浏览器工具栏里的扩展按钮即可收藏。</p>
      <ConnectionLine devices={devices.data ?? (devices.isError ? [] : null)} />
    </div>
  );
}
