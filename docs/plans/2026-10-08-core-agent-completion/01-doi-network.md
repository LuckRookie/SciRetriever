# 01 · DOI 请求与 Network 一致

## Outcome 与边界

Wiley TDM、DataCite/OpenAlex DOI lookup 的 adapter 请求通过普通 Network 并按原始编码到达服务器。
不为出版社增设 URL 白名单；Network 继续拥有目的地、路径、重定向及凭据安全。
进入条件：源码已离线复现三条 URL 被本地拒绝，普通主题及 Work ID 对照通过。

## Tasks

- [x] 1.1 允许安全的编码分隔符，递归检查解码后穿越/控制字符/歧义路径，保持线上路径字节。
- [x] 1.2 用真实 adapter、共享 transport 和本地服务验证 DOI 查询/下载及重定向，不 mock 掉 Network。
- [x] 1.3 补全编码绕过和普通 URL 回归；检查所有同类路径消费者与相关文档。

## 验证与退出

运行 network URL/redirect/credentials、metadata 和 acquisition 直接测试；端点实际收到完整 DOI，拒绝路径零请求。
退出要求：上述回归和安全负例通过。真实 Provider 权限不在本块验证内。
失败保留原始测试断言，不关闭目的地校验或绕开 Network；集成记录回填本块。

## 实施与证据（2026-10-08）

已完成通用路径规则修复；线上 URL 编码保持原样，递归解码仍拒绝穿越、重复斜杠、反斜杠和控制字符。
`provider-doi-network.test.ts` 使用真实 DataCite/OpenAlex/Wiley adapter、Network 和本地 TLS 服务，
断言两条 DOI 元数据路径及 Wiley PDF 重定向的完整编码路径和返回字节。仅替换 DNS/连接边界；未访问真实 Provider。
直接回归包括该文件、`network-url-policy.test.ts`、`network-redirect-credentials.test.ts`、`network-resolution-policy.test.ts`，
4 文件 / 8 项通过；全量结果以根 README 最终验收为准。
根因不仅是规则冲突：旧 Provider 测试替换整个 transport，无法发现共享 Network 的拒绝；此次集成回归补上该边界。
