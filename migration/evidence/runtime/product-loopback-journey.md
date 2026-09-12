# Browser 到内容查询的联合 loopback 旅程

> 本文件保留早期联合旅程的历史 bridge 记录。当前 Browser → Candidate → Parser → Analysis → Library 路径由
> TypeScript Application 组装；Python adapter/rules 仅作迁移 oracle，不属于生产运行时。

2026-09-10。`product-loopback-journey.test.ts` 使用已校验的目标 Cloak bundle 启动真实 Browser Host、代理、工作台
会话和临时 Application。测试取得 operator 控制权，从真实页面 observation 的封闭元素 ID 点击 PDF，等待下载进入
durable Candidate，按 receipt 正式发布，然后从 current primary PDF 继续 Parsing、迁移期 Python Analysis bridge、两次
OpenAI chat 兼容 loopback 模型调用、内容接纳和最终 Library Detail 查询。

旅程只访问随机 loopback fixture，所有 catalog、文件、Profile 和配置均在系统临时目录。模型 server 不接收凭据；
Parser port 使用固定合成输出并经过迁移期 Python artifact rules，最终结果为 `CONTENT_READY`；当前 TypeScript
Parser/Analysis rules 产生同一结果。页面内容、两次模型
调用和正式谱系均由真实 Application 对象图产生。

该测试保留固定 Parser fixture 作为 Application 对象图回归；同一目标的实际 MinerU HTTP 联合路径由
[Browser→MinerU→Analysis 联合旅程](browser-mineru-analysis-journey.md)补充。两者都不是发布包内嵌 Web 静态
资产的完整安装后产品旅程，也不声明真实 MinerU 服务、真实站点或真实模型效果。
