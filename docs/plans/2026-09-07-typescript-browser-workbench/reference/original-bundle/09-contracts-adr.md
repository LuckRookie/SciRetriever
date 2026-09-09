# 09｜协议草案与架构决策变更

以下是设计合同草案，不是已经编译验证的库。实施时以单一运行时schema生成TS类型和文档，避免前后端各定义一套。版本与字段采用英文；用户展示中文。

## 1. 执行策略

```typescript
type AssistanceMode = 'never' | 'notify' | 'pause';
type VersionChoice = 'published' | 'accepted-manuscript' | 'preprint';

interface ExecutionPolicy {
  readonly schemaVersion: 1;
  readonly sourceSelectionRef: string;
  readonly allowedVersions: readonly VersionChoice[];
  readonly allowPurchase: false;          // 首发不实现购买能力
  readonly allowAccountCreation: false;   // 首发不实现注册能力
  readonly credentialGrants: readonly string[]; // opaque grant IDs，不是secret
  readonly remoteImageDisclosure: boolean;
  readonly remotePdfUpload: boolean;
  readonly assistance: AssistanceMode;
  readonly unavailable: 'skip' | 'defer';
  readonly budgets: {
    readonly taskActiveTimeMs: number;
    readonly maxActions: number;
    readonly maxModelCalls: number;
    readonly maxRetryAttempts: number;
    readonly maxCandidateBytes: number;
  };
}
```

这些number在runtime schema中必须是有限、安全、合法范围内整数；空版本列表等交叉字段要有明确验证。sourceSelectionRef固定到任务创建时的有效选择，不在运行中跟随Auto列表变化。

taskActiveTimeMs按累计活动时间计量；用户明确暂停与等待人工期间不消耗该时间，但协助请求另有到期策略。重启不能重置已用动作、模型调用和重试预算；模型usage缺失时保留unknown/保守预算，不能当作零成本。

策略自然语言由AI整理为提案，用户确认后保存快照。运行中的Agent只引用快照，不能通过工具修改。secret使用grant绑定origin、允许操作和过期条件；即使传入有效grantId也要校验当前任务权限。

首发默认不购买、不注册，无需为此每遇到付费墙询问用户。新增这类能力属于另外的产品和安全变更，不是把false改成true就完成。

## 2. 动作包与控制权

```typescript
interface ActionEnvelope {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly workspaceId: string;
  readonly pageId: string;
  readonly bootId: string;
  readonly controlEpoch: number;
  readonly observationId?: string;
  readonly action: BrowserAction;
}

type BrowserAction =
  | { readonly type: 'click'; readonly elementRef: string }
  | { readonly type: 'clickPoint'; readonly frameId: string;
      readonly x: number; readonly y: number }
  | { readonly type: 'fill'; readonly elementRef: string; readonly text: string }
  | { readonly type: 'press'; readonly key: string }
  | { readonly type: 'select'; readonly elementRef: string;
      readonly values: readonly string[] }
  | { readonly type: 'hover'; readonly elementRef: string }
  | { readonly type: 'scroll'; readonly deltaX: number; readonly deltaY: number }
  | { readonly type: 'navigate'; readonly url: string }
  | { readonly type: 'back' | 'forward' | 'reload' }
  | { readonly type: 'switchTab'; readonly targetPageId: string }
  | { readonly type: 'waitForChange'; readonly timeoutMs: number };
```

这个union只展示共同操作合同；人工pointer down/up与IME通道另有有界schema，服务端映射到同一executor。Credential fill使用独立内部命令，不把secret作为上述text字段返回或持久化。

服务端认证身份决定输入者是谁；不相信客户端自报`actor=human`。job/attempt/policy作用域由服务端workspace绑定解析，不能通过伪造request payload扩大权限。

接收时依次检查协议、身份、workspace、boot、控制epoch、当前页面/观察绑定、动作schema和能力；派发前再次检查epoch。网络访问还需Network准入。重复requestId返回先前状态，不自动执行第二次。

控制epoch不能撤回已派发动作，也不能充当数据库事务。进程丢失后返回outcome-unknown而不是虚构failed/succeeded。严格控制权语义见 [03](03-browser-workbench.md)。

## 3. Observation 与帧

Observation字段：`observationId, workspaceId, pageId, documentGeneration, viewportRevision, observedAt, navigationState, elements, visibleText, transferSummaries, screenshotRef, completeness`。大小按字节限制，未知字段拒绝；截图与元素的版本不一致时标识或重取。

帧协议分元信息与二进制JPEG，共用frameId；不能让二者错配。前端不能凭server未见过的frameId点击。慢客户端丢帧；行为事件不按画面丢帧策略删除。版本变化后清空旧帧引用。

查看画面是一项访问能力，不是公开数据接口。远程图像提供给模型需要用户知情授权；登录/敏感表单阶段暂停发给模型的截图与文本，执行凭据操作由broker处理，完成后再恢复观察。隐藏输入字段并不能保证页面其它位置没有敏感信息，因此默认不持久保存登录截图，远程披露仍需策略与明确边界。

## 4. 候选交接与验收

```typescript
interface CandidateReady {
  readonly protocolVersion: 1;
  readonly candidateId: string;
  readonly attemptId: string;
  readonly stagingId: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly mediaType: string;
  readonly captureKind: 'download' | 'response' | 'blob' | 'assembled';
}

type IdentityVerdict =
  | { readonly result: 'match'; readonly evidenceIds: readonly string[] }
  | { readonly result: 'mismatch'; readonly reason: string;
      readonly evidenceIds: readonly string[] }
  | { readonly result: 'uncertain'; readonly reason: string;
      readonly evidenceIds: readonly string[] };
```

stagingId由内部store解析，前端/Agent不能提交任意文件路径。CandidateReady重复到达以candidateId和hash核验幂等；同ID不同hash是合同错误，不覆盖。最终receipt包含被接纳的assetId、literatureId与已提交hash，或者明确拒绝/待定状态。

IdentityVerdict.reason实施时为封闭枚举；证据对象包含来源位置与类别，不是模型随意生成的“高置信度”。文章身份与版本政策分别判断。只有Acquisition+Literature确认并Storage提交后才返回业务成功。

## 5. 服务入口草案

| 路径/动作 | 职责 | 约束 |
|---|---|---|
| `GET /api/v1/status` | 版本、readiness、catalog身份摘要 | 不联网探测，不输出secret或机器敏感路径 |
| `POST /api/v1/jobs` | 按目标和冻结策略创建任务 | idempotency key，范围/预算校验 |
| `GET /api/v1/jobs/:id` | 任务/目标/阶段结果 | 从持久记录+current facts组合 |
| `POST /api/v1/jobs/:id/pause|resume|cancel` | 作用域明确的运行控制 | pause不默默删除候选 |
| `GET /api/v1/workspaces` | workspace与页面概况 | 只返回授权范围 |
| `POST /api/v1/workspaces/:id/takeover` | 申请控制权 | 等待派发通道静默后发lease |
| `POST /api/v1/workspaces/:id/release` | 交还AI | 重新观察再恢复 |
| `WS /api/v1/events` | 有序状态事件/恢复游标 | 有界重放，旧游标过期返回重新同步 |
| `WS /api/v1/workspaces/:id/screen` | 授权画面流与输入 | binary帧、严格输入schema、epoch与背压 |
| `GET /api/v1/assets/:id` | 已确认资产读取/导出 | 通过受控reader，不是任意路径文件服务器 |

`/screen`也可拆分画面和操作WebSocket路径，但不能改变统一控制入口或扩大公开端口。OpenAPI/协议版本来自单一schema；不提供通用“执行代码/任意CDP/任意SQL/抓取任意文件”端点。

Job幂等创建与恢复同一请求只能产生一个job。状态事件有序不等于每个消费者实时收到；重连从存储读取关键状态，再追事件。连续视频帧不持久重放。

## 6. 必须变更的架构决策

以下使用临时名字，实施时检查仓库最新ADR编号后分配，不能覆盖已有编号或将本草案直接标为Accepted。[R21](10-sources.md#r21)

| 新ADR草案 | 决定 | 主要修订对象 |
|---|---|---|
| ADR-TS-APPLICATION | 全TS模块化单体、Node子进程/Worker、Python退役、窄native例外 | AGENTS/HARNESS；0019中实现栈偏好；技术设计 |
| ADR-BROWSER-WORKSPACE | Browser独立所有者、同一页面工作台、typed通用动作、control epoch | 0016、0017、0023；Network/Acquisition职责 |
| ADR-EXECUTION-POLICY | 冻结策略、自主处置、可禁用人工请求、凭据能力边界 | 0014、0015、0021、0023；产品需求 |
| ADR-DURABLE-EXECUTION | 可恢复jobs/attempt/candidate，运行事实不替代文献事实 | 0011、0012、0013；持久化限制 |
| ADR-CATALOG-V2 | v1字节/manifest兼容、显式v2迁移、备份/回滚、新表JSON局部例外 | Storage技术与schema合同 |
| ADR-NATIVE-ACCESS | 原生浏览器导航优先、独立Collector、SW覆盖、可验证网络/文件边界 | 0016、0023；Network和Acquisition验收 |

保留0001领域中立、0002保守身份、0003外部MinerU、0007引用support、0008两阶段内容、0010current parser、0018固定home等核心目的。不要因新框架便利恢复Collection、任意domain schema或多份业务状态。

## 7. 决策记录格式

每个新发现记：问题、当前证据、可选项、选择、对数据/安全/兼容的影响、需要的批准、对应任务和测试。尤其记录TS原生文件安全缺口、浏览器API兼容、PDF提取质量、Linux发行依赖。

未决问题必须有阻断范围和下一项验证，不允许写成“后续考虑”然后发布。也不能把项目内尚未批准的任意性能阈值当既有强制Harness门禁。[R03](10-sources.md#r03)
