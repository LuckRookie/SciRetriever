import { useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { LITERATURE_SOURCE_IDS } from "@sciretriever/contracts";
import {
  Button,
  Checkbox,
  Definition,
  Definitions,
  Section,
  TechDetails,
  TextField,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { record, type JsonRecord } from "../../data/wire.js";
import { sourceName } from "../../data/acquisition-wording.js";
import {
  readSourceDirectory,
  sourceDirectoryKey,
} from "../sources/SourceDirectory.js";
import { errorMessage, probeReason } from "../../strings.js";

export interface NetworkRoutes {
  sources: string[];
  doi_resolution: boolean;
  providers: string[];
  mineru: boolean;
  browser: boolean;
}
export const noRoutes: NetworkRoutes = {
  sources: [],
  doi_resolution: false,
  providers: [],
  mineru: false,
  browser: false,
};
/** The network part of a configuration, with the defaults the owner applies. */
export function networkOf(configuration: JsonRecord | null | undefined) {
  const network = configuration?.network
      ? record(configuration.network, "network")
      : {},
    routes = network.via_proxy ? record(network.via_proxy, "via_proxy") : {};
  return {
    proxy: typeof network.proxy === "string" ? network.proxy : null,
    via_proxy: {
      ...noRoutes,
      ...(routes as Partial<NetworkRoutes>),
    },
  };
}
/**
 * Services on this machine or the local network always connect directly, so
 * they are not offered. Hostnames that only resolve to a private address are
 * caught when the configuration is saved.
 */
export function isLocalService(url: unknown) {
  if (typeof url !== "string" || !url) return true;
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  } catch {
    return true;
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "::1" ||
    /^(127|10)\./u.test(host) ||
    /^192\.168\./u.test(host) ||
    /^169\.254\./u.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./u.test(host) ||
    /^f[cd][0-9a-f]{2}:/u.test(host) ||
    /^fe80:/u.test(host)
  );
}

export function NetworkSettings({
  configuration,
  saved,
  authentication,
  baseline,
  proxyAction,
  routesAction,
  onProxy,
  onRoutes,
  onCredential,
}: {
  /** The draft configuration. */
  configuration: JsonRecord;
  /** The saved configuration: tests, credentials and switches follow it. */
  saved: JsonRecord;
  authentication: boolean;
  baseline: string;
  proxyAction: ReactNode;
  routesAction: ReactNode;
  onProxy: (proxy: string | null) => void;
  onRoutes: (routes: NetworkRoutes) => void;
  onCredential: (result: JsonRecord) => void;
}) {
  const api = useApi();
  // Sources carry the names the source table shows.
  const directory = useQuery({
    queryKey: sourceDirectoryKey,
    queryFn: ({ signal }) => readSourceDirectory(api, signal),
    retry: false,
  });
  const name = (source: string) =>
    directory.data?.rows.find((row) => row.source === source)?.name ??
    sourceName(source);
  const draft = networkOf(configuration),
    savedProxy = networkOf(saved).proxy,
    routes = draft.via_proxy;
  const providers = Object.entries(
    record(configuration.providers ?? {}, "providers"),
  )
    .filter(([, value]) => !isLocalService(record(value, "provider").base_url))
    .map(([name]) => name);
  const parsing = record(configuration.parsing ?? {}, "parsing"),
    mineru =
      parsing.connection_mode === "remote" && !isLocalService(parsing.base_url);
  const toggle = (list: string[], name: string, on: boolean) =>
    on
      ? [...list.filter((n) => n !== name), name]
      : list.filter((n) => n !== name);
  return (
    <>
      <Section
        title="代理"
        description="只支持 HTTP CONNECT。填写地址不改变任何请求，哪些服务走代理在下一节选择。"
        action={proxyAction}
      >
        <Definitions>
          <Definition
            term="代理地址"
            description="http://主机:端口，可以是本机或局域网地址。"
          >
            <TextField
              label="代理地址"
              width="long"
              placeholder="http://127.0.0.1:7890"
              value={draft.proxy ?? ""}
              onChange={(value) => onProxy(value || null)}
            />
          </Definition>
          <Definition
            term="测试代理"
            description="用已保存的地址连接一个公网主机，只检查代理能否连通。"
          >
            <ProxyTest configured={!!savedProxy} />
          </Definition>
          <Definition
            term="认证"
            description="代理要求用户名和密码时填写；保存后不回显。"
          >
            {savedProxy ? (
              <ProxyAuthentication
                configured={authentication}
                baseline={baseline}
                onResult={onCredential}
              />
            ) : (
              <span className="settings-network-note">
                保存代理地址后可以填写。
              </span>
            )}
          </Definition>
        </Definitions>
      </Section>
      <Section
        title="走代理"
        description="选中的服务经代理连接，其余直连。本机或局域网上的服务始终直连，不在这里列出。"
        action={routesAction}
      >
        {savedProxy ? (
          <Definitions>
            <Definition
              term="文献来源"
              description="来源的检索、下载与测试；DOI 解析指获取 PDF 时对 doi.org 的解析。"
            >
              <span className="settings-choices">
                {LITERATURE_SOURCE_IDS.map((source) => (
                  <Checkbox
                    key={source}
                    isSelected={routes.sources.includes(source)}
                    onChange={(on) =>
                      onRoutes({
                        ...routes,
                        sources: toggle(routes.sources, source, on),
                      })
                    }
                  >
                    {name(source)}
                  </Checkbox>
                ))}
                <Checkbox
                  isSelected={routes.doi_resolution}
                  onChange={(on) => onRoutes({ ...routes, doi_resolution: on })}
                >
                  DOI 解析
                </Checkbox>
              </span>
            </Definition>
            <Definition
              term="模型"
              description="该服务商的全部模型调用与模型测试。"
            >
              {providers.length ? (
                <span className="settings-choices">
                  {providers.map((name) => (
                    <Checkbox
                      key={name}
                      isSelected={routes.providers.includes(name)}
                      onChange={(on) =>
                        onRoutes({
                          ...routes,
                          providers: toggle(routes.providers, name, on),
                        })
                      }
                    >
                      {name}
                    </Checkbox>
                  ))}
                </span>
              ) : (
                <span className="settings-network-note">
                  没有远程模型服务，本机服务始终直连。
                </span>
              )}
            </Definition>
            <Definition
              term="解析服务"
              description="提交、轮询与取回解析结果。"
            >
              {mineru ? (
                <Checkbox
                  isSelected={routes.mineru}
                  onChange={(on) => onRoutes({ ...routes, mineru: on })}
                >
                  MinerU
                </Checkbox>
              ) : (
                <span className="settings-network-note">
                  没有远程 MinerU，本机服务始终直连。
                </span>
              )}
            </Definition>
            <Definition
              term="浏览器"
              description="所有出版社页面共用一个浏览器，只能整体选择。"
            >
              <Checkbox
                isSelected={routes.browser}
                onChange={(on) => onRoutes({ ...routes, browser: on })}
              >
                浏览器
              </Checkbox>
            </Definition>
          </Definitions>
        ) : (
          <p className="settings-network-empty">先填写并保存代理地址。</p>
        )}
      </Section>
    </>
  );
}

function ProxyTest({ configured }: { configured: boolean }) {
  const api = useApi();
  const probe = useMutation({
    mutationFn: () =>
      api.request("/api/configuration/probe", {
        owner: "proxy",
        target: null,
        image: false,
      }),
  });
  const result = probe.data ? record(probe.data.result, "probe") : null,
    execution = result?.execution
      ? record(result.execution, "execution")
      : null,
    reason = typeof result?.reason === "string" ? result.reason : "";
  return (
    <div className="configuration-probe">
      <span className="settings-network-test">
        <Button
          isDisabled={!configured}
          isPending={probe.isPending}
          onPress={() => probe.mutate()}
        >
          测试代理
        </Button>
        {result ? (
          <span role="status" data-outcome={String(result.outcome)}>
            {result.outcome === "passed"
              ? `已连通 · ${Number(execution?.elapsed_ms ?? 0)} ms`
              : "错误"}
          </span>
        ) : null}
      </span>
      {probe.isError ? (
        <p role="alert">测试未完成：{errorMessage(probe.error)}</p>
      ) : null}
      {result && result.outcome !== "passed" && reason ? (
        <TechDetails>
          <p>
            {probeReason(reason)}（<code>{reason}</code>）
          </p>
        </TechDetails>
      ) : null}
    </div>
  );
}

function ProxyAuthentication({
  configured,
  baseline,
  onResult,
}: {
  configured: boolean;
  baseline: string;
  onResult: (result: JsonRecord) => void;
}) {
  const api = useApi();
  const [editing, setEditing] = useState(false),
    [user, setUser] = useState(""),
    [message, setMessage] = useState("");
  const secret = useRef<HTMLInputElement>(null);
  const submit = async (edit: JsonRecord) => {
    try {
      onResult(
        await api.request("/api/configuration/credential", { edit, baseline }),
      );
      return true;
    } catch (error) {
      setMessage(`认证未保存：${errorMessage(error)}`);
      return false;
    }
  };
  const save = async () => {
    const password = secret.current?.value ?? "";
    if (secret.current) secret.current.value = "";
    if (!user.trim() || !password) {
      setMessage("请填写用户名和密码。");
      return;
    }
    if (user.includes(":")) {
      setMessage("用户名不能包含冒号。");
      return;
    }
    if (
      await submit({
        namespace: "proxy",
        target: "proxy",
        kind: "set",
        value: `${user.trim()}:${password}`,
      })
    ) {
      setEditing(false);
      setUser("");
      setMessage("认证已保存，下一次连接代理时生效。");
    }
  };
  if (configured && !editing)
    return (
      <span className="settings-network-auth">
        <span className="settings-network-note">已配置</span>
        <Button size="compact" onPress={() => setEditing(true)}>
          替换
        </Button>
        <Button
          size="compact"
          variant="text"
          confirm={{
            title: "清除代理认证",
            description: "清除后，下一次连接代理时不再发送用户名和密码。",
            confirmLabel: "清除",
          }}
          onPress={async () => {
            if (
              await submit({
                namespace: "proxy",
                target: "proxy",
                kind: "remove",
              })
            )
              setMessage("认证已清除。");
          }}
        >
          清除
        </Button>
        {message ? <span role="status">{message}</span> : null}
      </span>
    );
  if (!editing)
    return (
      <span className="settings-network-auth">
        <span className="settings-network-note">未配置</span>
        <Button size="compact" onPress={() => setEditing(true)}>
          填写
        </Button>
        {message ? <span role="status">{message}</span> : null}
      </span>
    );
  return (
    <div className="settings-network-credential">
      <TextField
        label="代理用户名"
        placeholder="用户名"
        autoComplete="off"
        value={user}
        onChange={setUser}
      />
      <span className="credential-field">
        <input
          ref={secret}
          className="ui-input"
          aria-label="代理密码"
          placeholder="密码"
          type="password"
          autoComplete="new-password"
        />
      </span>
      <span className="settings-record-actions">
        <Button variant="primary" onPress={save}>
          保存认证
        </Button>
        <Button
          variant="text"
          onPress={() => {
            if (secret.current) secret.current.value = "";
            setUser("");
            setEditing(false);
            setMessage("");
          }}
        >
          取消
        </Button>
      </span>
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
