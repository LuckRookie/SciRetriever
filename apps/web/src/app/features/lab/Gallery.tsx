import { ResultState, SourceBadge } from "../archive/ResultState.js";
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ChipGroup,
  DataTable,
  Dialog,
  Disclosure,
  Drawer,
  EmptyState,
  ErrorNotice,
  FilterChip,
  Icon,
  IconButton,
  ListRow,
  Menu,
  NumberField,
  PageHeader,
  Popover,
  Radio,
  RadioGroup,
  SearchField,
  SegmentedControl,
  Select,
  Skeleton,
  SplitPane,
  Switch,
  Tabs,
  TechDetails,
  TextArea,
  TextField,
  Tooltip,
  useToast,
} from "../../components/index.js";
import { useMotionPreference } from "../../motion/index.js";
import { ShellContext } from "../../shell/context.js";
import { bindTheme, type Theme } from "../../data/preferences.js";
import "./lab.css";
const samples = [
  { id: "first", title: "可追溯的研究材料", year: 2024 },
  { id: "second", title: "固定版本与证据", year: 2026 },
  { id: "third", title: "文献的原始数据", year: 2023 },
];
export function AppearanceControls() {
  const shell = useContext(ShellContext);
  const [localTheme, setLocalTheme] = useState<Theme>(
    (document.documentElement.dataset.theme as Theme | undefined) ?? "light",
  );
  const theme = shell?.theme ?? localTheme;
  useEffect(
    () => (shell ? undefined : bindTheme(localTheme)),
    [shell, localTheme],
  );
  const motion = useMotionPreference();
  return (
    <div className="lab-appearance">
      <Select
        label="画廊主题"
        value={theme}
        onChange={(value) => {
          if (shell) shell.setTheme(value as Theme);
          else setLocalTheme(value as Theme);
        }}
        options={[
          { value: "light", label: "蓝白" },
          { value: "dark", label: "深色" },
          { value: "green", label: "墨绿" },
          { value: "warm", label: "暖白" },
          { value: "system", label: "跟随系统" },
        ]}
      />
      <Switch
        isSelected={motion.reduced}
        onChange={(value) => motion.setPreference(value ? "reduced" : "full")}
      >
        减少动效
      </Switch>
    </div>
  );
}
function Example({
  title,
  usage,
  children,
}: {
  title: string;
  usage: string;
  children: ReactNode;
}) {
  return (
    <section className="lab-section">
      <header>
        <h2>{title}</h2>
        <p>{usage}</p>
      </header>
      <div className="lab-examples">{children}</div>
    </section>
  );
}
function DisclosureDraft() {
  const [draft, setDraft] = useState("");
  return <TextField label="折叠区草稿" value={draft} onChange={setDraft} />;
}
export default function Gallery() {
  const [text, setText] = useState(""),
    [search, setSearch] = useState(""),
    [area, setArea] = useState(""),
    [number, setNumber] = useState(20),
    [choice, setChoice] = useState("all"),
    [checked, setChecked] = useState(false),
    [radio, setRadio] = useState("full"),
    [enabled, setEnabled] = useState(true),
    [view, setView] = useState("pdf"),
    [tab, setTab] = useState("library"),
    [filter, setFilter] = useState(false),
    [dialog, setDialog] = useState(false),
    [drawer, setDrawer] = useState(false),
    [count, setCount] = useState(0),
    [width, setWidth] = useState(260),
    [selected, setSelected] = useState(new Set<string>());
  const [submissionPending, setSubmissionPending] = useState(false),
    [submissionCount, setSubmissionCount] = useState(0);
  const finishSubmission = useRef<(() => void) | null>(null);
  const toast = useToast();
  return (
    <div className="lab-page">
      <PageHeader
        title="组件画廊"
        description="与文献库共用的控件、状态与主题。这里的交互仅使用合成示例，不访问服务。"
      />
      <AppearanceControls />
      <Example
        title="校订来源与结果状态"
        usage="按篇区分有结果、结果为空和读取不完整。此处为合成展示数据。"
      >
        <SourceBadge source="manual" pageOnly />
        <ResultState
          outcomes={{ with_result: 3, empty: 1, incomplete: 1 }}
          freshness={{
            state: "stale",
            reasons: [{ kind: "content-version-changed" }],
          }}
        />
      </Example>
      <Example
        title="动作"
        usage="主操作、次要操作与显式加工使用同一尺寸；加工会先确认，取消不执行。"
      >
        <div className="lab-inline">
          <Button variant="primary" onPress={() => toast("示例操作已完成")}>
            主要操作
          </Button>
          <Button>次要操作</Button>
          <Button variant="text">文字操作</Button>
          <Button variant="danger" onPress={() => toast("仅演示状态")}>
            移除示例
          </Button>
          <Button
            variant="process"
            icon={<Icon name="spark" />}
            confirm={{
              title: "确认示例加工",
              description: "这是离线行为演示，不调用模型，也不修改文献库。",
              scope: "3 篇合成文献",
              service: "无外部服务",
              confirmLabel: "执行示例",
            }}
            onPress={async () => {
              await new Promise((resolve) => setTimeout(resolve, 350));
              setCount((value) => value + 1);
            }}
          >
            示例加工
          </Button>
          <output aria-label="加工执行次数">已执行 {count} 次</output>
        </div>
        <div className="lab-inline">
          <Button size="compact">紧凑操作</Button>
          <Button
            onPress={async () => {
              setSubmissionPending(true);
              setSubmissionCount((value) => value + 1);
              await new Promise<void>((resolve) => {
                finishSubmission.current = resolve;
              });
              finishSubmission.current = null;
              setSubmissionPending(false);
            }}
          >
            提交反馈示例
          </Button>
          <Button
            isDisabled={!submissionPending}
            onPress={() => finishSubmission.current?.()}
          >
            完成反馈示例
          </Button>
          <output aria-label="反馈示例提交次数">{submissionCount}</output>
          <Button isPending>正在提交</Button>
          <Button isDisabled disabledReason="没有已接纳的 PDF，无法解析。">
            解析
          </Button>
          <IconButton aria-label="刷新示例" onPress={() => toast("示例已刷新")}>
            <Icon name="refresh" />
          </IconButton>
          <IconButton size="compact" aria-label="添加示例">
            <Icon name="plus" />
          </IconButton>
          <IconButton size="inline" aria-label="关闭示例">
            <Icon name="close" />
          </IconButton>
          <Tooltip text="提示与键盘焦点一起出现">
            <Button variant="text">查看提示</Button>
          </Tooltip>
        </div>
      </Example>
      <Example
        title="输入"
        usage="错误就近说明，字段始终有标签。搜索支持 Escape 清空，多行输入随内容增高。"
      >
        <div className="lab-fields">
          <TextField
            label="文献标题"
            value={text}
            onChange={setText}
            placeholder="输入标题"
            description="只修改本页示例。"
          />
          <SearchField
            label="搜索示例"
            value={search}
            onChange={setSearch}
            placeholder="标题、作者或关键词"
            onSubmit={() => toast("已提交示例检索")}
          />
          <Select
            label="材料范围"
            value={choice}
            onChange={setChoice}
            options={[
              { value: "all", label: "全部材料" },
              { value: "pdf", label: "已有 PDF" },
              { value: "missing", label: "尚未解析", disabled: true },
            ]}
          />
          <NumberField
            label="阅读字号"
            value={number}
            onChange={setNumber}
            minValue={18}
            maxValue={24}
            step={2}
          />
          <TextField
            label="必填示例"
            value=""
            onChange={() => {}}
            isRequired
            errorMessage="请填写研究问题。"
          />
          <TextField
            label="锁定的输入"
            value="固定材料版本"
            onChange={() => {}}
            isDisabled
          />
          <TextArea
            label="研究问题"
            value={area}
            onChange={setArea}
            placeholder="可以输入多行内容。"
            description="保留未提交的文字，直到你明确执行。"
          />
        </div>
        <div className="lab-inline">
          <Checkbox isSelected={checked} onChange={setChecked}>
            选中文献
          </Checkbox>
          <Checkbox isSelected={false} isIndeterminate onChange={() => {}}>
            部分选中
          </Checkbox>
          <Switch isSelected={enabled} onChange={setEnabled}>
            显示信息栏
          </Switch>
          <RadioGroup label="读取范围" value={radio} onChange={setRadio}>
            <Radio value="full">全文</Radio>
            <Radio value="matching">匹配片段</Radio>
            <Radio value="unavailable" isDisabled>
              尚无材料
            </Radio>
          </RadioGroup>
        </div>
      </Example>
      <Example
        title="选择与导航"
        usage="分段选择同一对象的视图，标签切换分区，筛选标签缩小当前范围。"
      >
        <SegmentedControl
          label="阅读视图示例"
          value={view}
          onChange={setView}
          items={[
            { id: "pdf", label: "PDF" },
            { id: "document", label: "全文" },
            { id: "summary", label: "总结" },
          ]}
        />
        <Tabs
          label="分区示例"
          value={tab}
          onChange={setTab}
          items={[
            { id: "library", label: "文献库" },
            { id: "materials", label: "材料" },
            { id: "history", label: "来源" },
          ]}
        >
          <p>
            {tab === "library"
              ? "当前文献库"
              : tab === "materials"
                ? "已接纳材料"
                : "材料来源"}
          </p>
        </Tabs>
        <ChipGroup label="筛选示例">
          <FilterChip
            isSelected={!filter}
            onChange={() => setFilter(false)}
            count={3}
          >
            全部文献
          </FilterChip>
          <FilterChip
            isSelected={filter}
            onChange={setFilter}
            count={2}
            onRemove={() => setFilter(false)}
          >
            已有 PDF
          </FilterChip>
        </ChipGroup>
        <div className="lab-inline">
          {(
            [
              "metadata",
              "pdf",
              "ready",
              "running",
              "partial",
              "completed",
              "failed",
              "unavailable",
            ] as const
          ).map((status) => (
            <Badge key={status} status={status} />
          ))}
        </div>
        <Disclosure title="查看覆盖范围">
          <p>示例包含三篇合成文献，无真实查询或加工。</p>
          <DisclosureDraft />
        </Disclosure>
        <Disclosure title="查看长内容">
          {Array.from({ length: 30 }, (_, index) => (
            <p key={index}>
              合成长段落 {index + 1}，仅用于检查直接展开和键盘可达。
            </p>
          ))}
        </Disclosure>
      </Example>
      <Example
        title="浮层与反馈"
        usage="菜单用来选择动作；对话框保护需要确认的操作；提示不会替代任务回执。"
      >
        <div className="lab-inline">
          <Menu
            label="更多操作"
            items={[
              {
                id: "view",
                label: "查看示例",
                onAction: () => toast("已选择查看"),
              },
              {
                id: "copy",
                label: "复制示例",
                shortcut: "⌘C",
                onAction: () => toast("已选择复制"),
              },
              {
                id: "disabled",
                label: "解析材料",
                description: "需要已有 PDF",
                disabled: true,
                onAction: () => {},
              },
            ]}
          />
          <Popover label="查看证据" trigger="证据 [1]">
            <p>这是固定原文片段的展示示例，不对应任何真实论文。</p>
            <Button variant="text" onPress={() => toast("证据跳转示例")}>
              在原文核对
            </Button>
          </Popover>
          <Button onPress={() => setDialog(true)}>打开对话框</Button>
          <Button onPress={() => setDrawer(true)}>打开活动抽屉</Button>
          <Button
            onPress={() =>
              toast({
                message: "示例结果已就绪",
                action: { label: "查看", onPress: () => setDrawer(true) },
              })
            }
          >
            显示提示条
          </Button>
        </div>
        <Dialog
          title="对话框示例"
          isOpen={dialog}
          onOpenChange={setDialog}
          footer={
            <Button variant="primary" onPress={() => setDialog(false)}>
              完成
            </Button>
          }
        >
          <p>按 Escape 关闭后，焦点返回打开按钮。</p>
          <TextField label="对话框输入" value={text} onChange={setText} />
        </Dialog>
        <Drawer title="活动示例" isOpen={drawer} onOpenChange={setDrawer}>
          <EmptyState
            title="没有进行中的任务"
            description="显式提交加工后，可在这里查看状态。"
          />
        </Drawer>
      </Example>
      <Example
        title="内容与证据"
        usage="普通内容保持平面；技术信息折叠但可以核对，错误保留已读材料。"
      >
        <ErrorNotice
          message="后续内容暂时读取失败。"
          retained="前面已加载的正文仍然保留。"
          onRetry={() => toast("已请求示例重试")}
        />
        <Card title="合成结果说明">
          <p>只有需要独立概括的内容才使用卡片。</p>
        </Card>
        <ListRow
          title="可追溯的文献知识"
          bibliography={
            <>
              Sample Authors <i>Research Fixture</i> 2026
            </>
          }
          leading={
            <Checkbox
              aria-label="选择内容示例"
              isSelected={checked}
              onChange={setChecked}
            />
          }
          badge={<Badge status="ready" />}
          action={
            <IconButton aria-label="预览内容示例">
              <Icon name="eye" />
            </IconButton>
          }
        />
        <TechDetails copyText="fixture: components-only">
          <p>来源：合成组件示例</p>
          <p>固定引用：fixture-components-only</p>
        </TechDetails>
        <Skeleton label="合成加载状态" rows={2} />
        <EmptyState
          title="当前筛选没有文献"
          description="清除筛选后查看已有材料。"
          action={<Button onPress={() => setFilter(false)}>清除筛选</Button>}
        />
      </Example>
      <Example
        title="结果表与栏宽"
        usage="表格只对当前示例页排序；拖动、方向键或双击调整栏宽。"
      >
        <DataTable
          label="合成结果表"
          rows={samples}
          columns={[
            { id: "title", header: "标题", value: (row) => row.title },
            { id: "year", header: "年份", value: (row) => row.year },
          ]}
          getRowId={(row) => row.id}
          selected={selected}
          onSelectionChange={setSelected}
        />
        <SplitPane
          label="示例侧栏宽度"
          width={width}
          onWidthChange={setWidth}
          min={180}
          max={360}
          defaultWidth={260}
          side={<div className="lab-split-content">可调整的信息栏</div>}
        >
          <div className="lab-split-content">主要阅读区域</div>
        </SplitPane>
      </Example>
    </div>
  );
}
export { Gallery };
