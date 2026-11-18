import { useState, type CSSProperties } from "react";
import {
  Button,
  ChipGroup,
  Dialog,
  Disclosure,
  FilterChip,
  Menu,
  NumberField,
  PageHeader,
  SegmentedControl,
  Select,
  Tabs,
  TechDetails,
  useToast,
} from "../../components/index.js";
import {
  ExperimentMotion,
  MotionScope,
  MotionTuningProvider,
  Presence,
  type MotionTuning,
} from "../../motion/index.js";
import { AppearanceControls } from "./Gallery.js";
import "./lab.css";
type Variant = "a" | "b" | "c";
const experiments = [
  "主要按钮按下与松开",
  "筛选标签切换",
  "分段控件切换",
  "页内标签切换",
  "菜单弹出与关闭",
  "对话框",
  "提示条",
  "筛选面板展开",
  "信息栏收起",
  "提交状态反馈",
  "证据定位高亮",
  "列表项增删",
];
function Sample({ kind, variant }: { kind: number; variant: Variant }) {
  const [active, setActive] = useState(false),
    [selected, setSelected] = useState("pdf"),
    [count, setCount] = useState(1),
    [pending, setPending] = useState(false),
    [result, setResult] = useState(""),
    [fail, setFail] = useState(false);
  const toast = useToast();
  const caption = variant.toUpperCase();
  const content =
    kind === 0 ? (
      <div
        onPointerDown={() => setActive(true)}
        onPointerUp={() => setActive(false)}
        onPointerLeave={() => setActive(false)}
      >
        <ExperimentMotion kind="press" active={variant === "c" && active}>
          <Button
            variant="primary"
            onPress={() => setCount((value) => value + 1)}
          >
            按下 · {count - 1}
          </Button>
        </ExperimentMotion>
      </div>
    ) : kind === 1 ? (
      <ChipGroup label={`${caption} 筛选`}>
        <FilterChip isSelected={!active} onChange={() => setActive(false)}>
          全部
        </FilterChip>
        <FilterChip isSelected={active} onChange={() => setActive(true)}>
          已有 PDF
        </FilterChip>
      </ChipGroup>
    ) : kind === 2 ? (
      <SegmentedControl
        label={`${caption} ${kind === 2 ? "阅读视图" : "页内标签"}`}
        value={selected}
        onChange={setSelected}
        items={[
          { id: "pdf", label: kind === 2 ? "PDF" : "文献" },
          { id: "doc", label: kind === 2 ? "全文" : "材料" },
          { id: "summary", label: kind === 2 ? "总结" : "来源" },
        ]}
      />
    ) : kind === 3 ? (
      <Tabs
        label={`${caption} 页内标签`}
        value={selected}
        onChange={setSelected}
        items={[
          { id: "pdf", label: "文献" },
          { id: "doc", label: "材料" },
          { id: "summary", label: "来源" },
        ]}
      />
    ) : kind === 4 ? (
      <Menu
        label={`${caption} 操作菜单`}
        items={[
          {
            id: "copy",
            label: "查看示例",
            onAction: () => setResult("已选择查看"),
          },
          {
            id: "export",
            label: "导出示例",
            onAction: () => setResult("已选择导出"),
          },
        ]}
      />
    ) : kind === 5 ? (
      <>
        <Button onPress={() => setActive(true)}>打开 {caption} 对话框</Button>
        <Dialog
          title={`${caption} 对话框示例`}
          isOpen={active}
          onOpenChange={setActive}
          className={`lab-dialog-${variant}`}
        >
          <p>同一操作结构，比较出现与关闭的手感。</p>
          <Button onPress={() => setActive(false)}>完成</Button>
        </Dialog>
      </>
    ) : kind === 6 ? (
      <>
        <Button
          onPress={() => {
            setActive(true);
            toast(`${caption} 提示示例`);
          }}
        >
          显示提示
        </Button>
        {active ? (
          <div className="lab-inline-message" role="status">
            材料已准备好
            <Button
              size="inline"
              variant="text"
              onPress={() => setActive(false)}
            >
              关闭
            </Button>
          </div>
        ) : null}
      </>
    ) : kind === 7 ? (
      <>
        <Button onPress={() => setActive((value) => !value)}>筛选条件</Button>
        <Presence>
          {active ? (
            <ExperimentMotion key="filter">
              <div className="lab-demo-panel">
                <Select
                  label={`${caption} 年份`}
                  value={selected}
                  onChange={setSelected}
                  options={[
                    { value: "pdf", label: "所有年份" },
                    { value: "doc", label: "2026 年" },
                    { value: "summary", label: "2025 年" },
                  ]}
                />
              </div>
            </ExperimentMotion>
          ) : null}
        </Presence>
      </>
    ) : kind === 8 ? (
      <>
        <Button onPress={() => setActive((value) => !value)}>
          {active ? "显示信息栏" : "收起信息栏"}
        </Button>
        <div className="lab-reader-demo">
          <div className="lab-pdf-demo" aria-label={`${caption} 模拟 PDF 画布`}>
            <span>论文标题</span>
            <i />
            <i />
            <i />
            <i />
          </div>
          {!active ? (
            <ExperimentMotion>
              <aside>
                文献信息
                <br />
                已保存的材料
              </aside>
            </ExperimentMotion>
          ) : null}
        </div>
      </>
    ) : kind === 9 ? (
      <>
        <Select
          label={`${caption} 模拟回执`}
          value={fail ? "failure" : "success"}
          onChange={(value) => setFail(value === "failure")}
          options={[
            { value: "success", label: "成功" },
            { value: "failure", label: "失败" },
          ]}
        />
        <Button
          isPending={pending}
          onPress={async () => {
            setPending(true);
            setResult("");
            await new Promise((resolve) => setTimeout(resolve, 500));
            setResult(fail ? "读取未完成，可重试。" : "已提交");
            setPending(false);
          }}
        >
          提交示例
        </Button>
      </>
    ) : kind === 10 ? (
      <>
        <Button onPress={() => setActive((value) => !value)}>定位证据</Button>
        <ExperimentMotion kind="highlight" active={active}>
          <p className="lab-demo-evidence">仅标记固定来源中的证据文字。</p>
        </ExperimentMotion>
      </>
    ) : (
      <>
        <div className="lab-inline">
          <Button
            size="compact"
            onPress={() => setCount((value) => Math.min(4, value + 1))}
          >
            增加
          </Button>
          <Button
            size="compact"
            onPress={() => setCount((value) => Math.max(0, value - 1))}
          >
            移除
          </Button>
        </div>
        <Presence>
          {Array.from({ length: count }, (_, index) => (
            <ExperimentMotion key={index} kind="item">
              <div className="lab-demo-item">示例文献 {index + 1}</div>
            </ExperimentMotion>
          ))}
        </Presence>
      </>
    );
  return (
    <MotionScope disabled={variant !== "c"}>
      <div
        className={`lab-variant lab-variant-${variant}`}
        data-variant={variant}
      >
        <h3>
          {caption} ·{" "}
          {variant === "a"
            ? "现状静态"
            : variant === "b"
              ? "CSS 过渡"
              : "Motion"}
        </h3>
        <div className="lab-variant-content">
          {content}
          {result ? <p role="status">{result}</p> : null}
        </div>
      </div>
    </MotionScope>
  );
}
function exportParameters(value: MotionTuning) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "sciretriever-motion-parameters.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function Lab() {
  const [tuning, setTuning] = useState<MotionTuning>({
    stiffness: 520,
    damping: 38,
    pressScale: 0.98,
    durationScale: 1,
  });
  return (
    <MotionTuningProvider value={tuning}>
      <div
        className="lab-page lab-comparison-page"
        style={
          {
            "--lab-duration": `${180 * tuning.durationScale}ms`,
            "--lab-press": String(tuning.pressScale),
          } as CSSProperties
        }
      >
        <PageHeader
          title="交互手感实验台"
          description="十二组相同操作，分别比较原有静态反馈、CSS 过渡和 Motion。所有数据都是合成示例。"
        />
        <AppearanceControls />
        <div className="lab-tuning">
          <label>
            弹簧刚度 · {tuning.stiffness}
            <input
              type="range"
              aria-label="弹簧刚度"
              min="100"
              max="900"
              step="20"
              value={tuning.stiffness}
              onChange={(event) =>
                setTuning({ ...tuning, stiffness: Number(event.target.value) })
              }
            />
          </label>
          <label>
            阻尼 · {tuning.damping}
            <input
              type="range"
              aria-label="弹簧阻尼"
              min="10"
              max="70"
              step="2"
              value={tuning.damping}
              onChange={(event) =>
                setTuning({ ...tuning, damping: Number(event.target.value) })
              }
            />
          </label>
          <Select
            label="按下缩放"
            value={String(tuning.pressScale)}
            onChange={(value) =>
              setTuning({ ...tuning, pressScale: Number(value) })
            }
            options={[
              { value: "1", label: "1.00" },
              { value: "0.98", label: "0.98" },
              { value: "0.97", label: "0.97" },
            ]}
          />
          <NumberField
            label="时长倍率"
            value={tuning.durationScale}
            onChange={(value) => setTuning({ ...tuning, durationScale: value })}
            minValue={0.5}
            maxValue={2}
            step={0.25}
          />
          <Button onPress={() => exportParameters(tuning)}>
            导出参数 JSON
          </Button>
        </div>
        {experiments.map((name, index) => (
          <section className="lab-section" key={name} aria-label={name}>
            <h2>{name}</h2>
            <div className="lab-comparisons">
              {(["a", "b", "c"] as const).map((variant) => (
                <Sample key={variant} kind={index} variant={variant} />
              ))}
            </div>
          </section>
        ))}
        <TechDetails
          title="当前实验参数"
          copyText={JSON.stringify(tuning, null, 2)}
        >
          <pre>{JSON.stringify(tuning, null, 2)}</pre>
        </TechDetails>
        <Disclosure title="动效边界">
          <p>
            栏目切换、PDF页和拖动宽度不加布局动画。减少动效时立即完成；业务状态不等待动画结束。
          </p>
        </Disclosure>
      </div>
    </MotionTuningProvider>
  );
}
export { Lab };
