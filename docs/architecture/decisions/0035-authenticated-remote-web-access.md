# ADR 0035：统一登录的单用户 Web 服务

状态：Accepted（2026-10-19）。Owner 明确要求删除本机免登录模式：启动即允许其他电脑访问，所有访问统一登录；未指定密码时在启动终端显示自动生成的 API key。

## 决策

Web 只有一种启动和认证方式。`sciretriever web` 默认监听 `0.0.0.0:4174`，本机和其他电脑均须登录。可选监听地址只改变网络绑定，不改变认证规则；不提供免登录开关，也不要求配置公开 origin。当前支持服务器 IPv4 地址和端口上的 HTTP 直连，HTTPS、域名和反向代理部署另行设计。登录者具有该工作台的完整操作权限，不引入账户、角色或多租户系统。

启动时若提供 `SCIRETRIEVER_WEB_PASSWORD`，使用该密码且不回显；未提供时，用密码学安全随机数生成 256 位访问密钥，在成功启动的终端输出中显示一次 `api_key`。密码和 API key 使用同一登录框、同一校验协议，没有第二种认证模式。指定了无效密码时拒绝启动，不静默替换。自动密钥每次启动重新生成，固定密码由操作者在启动环境提供；不增加配置向导、交互式启动提问或自动凭据文件。

HTTP 传输适配拥有凭据校验和临时会话。启动终端显示自动密钥是 owner 明确授权的交付方式，指定密码、Provider 凭据、Cookie 和 Token 仍不得输出。密码和密钥不写入普通配置、catalog、业务日志、URL 或浏览器存储，不通过 HTTP 读接口返回；程序组装接口只将自动生成的密钥返回给启动调用方。Web CLI 消费后移除进程环境中的密码，避免传给 Agent 子进程。校验使用加盐派生值；登录会话使用不可预测的 HttpOnly、SameSite Cookie。

Host 仅用于确定当前请求的 HTTP origin，不构成认证证明。允许合法 IPv4 字面地址（包括 NAT 映射后的地址/端口）和 localhost；不接受任意域名，不信任 `Forwarded` / `X-Forwarded-*`。浏览器请求的 Origin 必须与当前 Host 对应的 origin 一致，跨站请求拒绝。登录必须显式 POST 并携带原有初始化头；业务请求继续校验客户端令牌、CSRF、版本和 Browser 控制权。本机请求不豁免任何认证。HTTP 不加密密码和资料，登录认证不等于传输加密。

会话有绝对期限与数量上限，退出和进程重启使会话失效；撤销同时释放所属 tab grants 和观看连接，遵守既有 Browser detach 政策，不取消已提交的 durable tasks。文献查询、文件、配置、任务、Browser 画面和共享维护路由均在认证之后执行；未登录不调用业务服务，已提交事实不因退出而回滚。

CLI/MCP 显式连接 Web runtime 时，无论地址是本机还是服务器，都通过 `SCIRETRIEVER_WEB_PASSWORD` 提供同一密码或终端生成的 API key，使用相同登录协议。直接操作业务 owner 的普通 CLI/MCP 不依赖 Web 登录。已有独立 query-only/maintenance SDK 适配保持其限定能力和原有网络边界，不作为 `web` 命令的启动模式。

## 影响与兼容性

修订本 ADR 初稿中的“默认本机免登录、显式远程认证”选择，不增加平行模式。旧的 `web --port …` 命令现在默认对外监听并要求登录；移除初稿 `--origin` / `publicOrigin`。监听 `127.0.0.1` 也必须登录。程序启动返回值增加监听地址、可用 URL 和仅自动生成时存在的 `apiKey`，调用方负责显示给操作者，不应将整个返回值写入持久日志。

扩展 [ADR 0032](0032-library-centered-web-workspace.md) 的部署方式，保持 [ADR 0033](0033-machine-interfaces-cover-web-capabilities.md) 的三端能力关系。不迁移文献、资产、catalog 或普通配置。精确命令、期限和限额见 [Web 指南](../../guides/web-workbench.md) 与直接测试。
