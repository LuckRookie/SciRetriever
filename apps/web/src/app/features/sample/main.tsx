import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  Badge,
  Button,
  Card,
  Drawer,
  PageHeader,
} from "../../components/index.js";
import { MotionProvider } from "../../motion/index.js";
import {
  canPublish,
  completeDemoCapture,
  createDemoState,
  hasCandidate,
  type DemoPhase,
  type DemoScenario,
  type DemoState,
} from "./state.js";
import "../../styles/tokens.css";
import "../../styles/base.css";
import "../../styles/components.css";
import "../../../../entry/public/react-aria.css";
import "./sample.css";
const labels: Record<DemoPhase, string> = {
  idle: "示例页面已准备好",
  running: "正在演示 PDF 获取…",
  paused: "演示已暂停",
  ready: "候选已准备好，等待确认",
  uncertain: "候选已保留，身份待确认",
  blocked: "示例请求被网络策略拒绝",
  published: "演示入库完成",
  cancelled: "会话已取消",
};
function Sample() {
  const [state, setState] = useState(createDemoState),
    [open, setOpen] = useState(false),
    [viewport] = useState(() => matchMedia("(max-width: 700px)"));
  const narrow = useSyncExternalStore(
    (notify) => {
      viewport.addEventListener("change", notify);
      return () => viewport.removeEventListener("change", notify);
    },
    () => viewport.matches,
  );
  const generation = useRef(0),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => {
    generation.current++;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const change = (apply: (draft: DemoState) => void) =>
    setState((current) => {
      const draft = { ...current, events: [...current.events] };
      apply(draft);
      return draft;
    });
  const event = (draft: DemoState, text: string) => {
    draft.events = [
      ...draft.events.slice(-9),
      {
        label: text,
        time: `00:${String(draft.events.length + 1).padStart(2, "0")}`,
      },
    ];
  };
  const capture = () => {
    if (
      state.phase === "running" ||
      hasCandidate(state.phase) ||
      state.phase === "cancelled"
    )
      return;
    stop();
    const current = generation.current;
    change((draft) => {
      draft.phase = "running";
      event(
        draft,
        draft.operator ? "人工点击示例 PDF 入口" : "开始演示受控 PDF 获取",
      );
    });
    timer.current = setTimeout(() => {
      if (generation.current !== current) return;
      change((draft) => {
        completeDemoCapture(draft);
        event(draft, labels[draft.phase]);
      });
    }, 1000);
  };
  const candidate = hasCandidate(state.phase),
    finished = state.phase === "published",
    cancelled = state.phase === "cancelled",
    running = state.phase === "running";
  const reset = (scenario = state.scenario) => {
    stop();
    setState(createDemoState(scenario));
    setOpen(false);
  };
  const publish = () => {
    if (!canPublish(state.phase)) return;
    change((draft) => {
      draft.phase = "published";
      draft.operator = false;
      event(draft, "演示候选已确认入库");
    });
  };
  const inspection = (
    <div className="sample-inspection">
      <Card title="候选与证据">
        <div id="candidate-empty" hidden={candidate}>
          <p>尚未生成候选。先演示获取，再核对证据。</p>
        </div>
        <div id="candidate-result" hidden={!candidate}>
          <h3>Synthetic research article</h3>
          <p>示例 PDF · 2 页 · 128 KB</p>
          <p id="version-evidence">
            {state.phase === "uncertain"
              ? "缺少版本证据，暂不能确认入库。"
              : "标题与版本证据匹配。"}
          </p>
          <Button
            id="publish-button"
            variant="primary"
            isDisabled={!canPublish(state.phase)}
            onPress={publish}
          >
            确认入库（演示）
          </Button>
          <Button
            isDisabled={finished}
            onPress={() => {
              stop();
              change((draft) => {
                draft.phase = "idle";
                event(draft, "已放弃本次候选");
              });
            }}
          >
            放弃候选
          </Button>
        </div>
      </Card>
      <Card title="会话动态">
        <ol>
          {state.events.slice(-4).map((item, index) => (
            <li key={index}>
              <time>{item.time}</time> {item.label}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
  return (
    <main className="sample-workspace">
      <PageHeader
        title="Browser 合成示例"
        description="仅演示界面与交互，不连接数据库、Browser Host 或外部服务。刷新后恢复初始状态。"
        action={<Button onPress={() => reset()}>重新演示</Button>}
      />
      <div className="sample-toolbar" role="group" aria-label="样本场景">
        {(
          [
            ["normal", "正常获取"],
            ["uncertain", "身份待确认"],
            ["blocked", "网络拒绝"],
          ] as const
        ).map(([scenario, label]) => (
          <Button
            key={scenario}
            aria-pressed={state.scenario === scenario}
            onPress={() => reset(scenario as DemoScenario)}
          >
            {label}
          </Button>
        ))}
        <span>
          候选 <b id="candidate-count">{candidate ? 1 : 0}</b>
        </span>
        <span>
          演示入库 <b id="library-count">{finished ? 1 : 0}</b>
        </span>
      </div>
      <div className="sample-layout">
        <section className="sample-stage">
          <div className="sample-toolbar">
            <Button
              id="run-button"
              variant="primary"
              isDisabled={running || candidate || cancelled || state.operator}
              onPress={capture}
            >
              演示获取
            </Button>
            <Button
              id="takeover-button"
              isDisabled={cancelled || finished}
              onPress={() => {
                stop();
                change((draft) => {
                  if (draft.phase === "running") draft.phase = "paused";
                  draft.operator = !draft.operator;
                  event(
                    draft,
                    draft.operator
                      ? "你已接管页面，自动操作停止"
                      : "你已释放页面控制权",
                  );
                });
              }}
            >
              {state.operator ? "释放控制" : "人工接管"}
            </Button>
            <Button
              id="pause-button"
              isDisabled={!running}
              onPress={() => {
                stop();
                change((draft) => {
                  draft.phase = "paused";
                  event(draft, "获取演示已暂停");
                });
              }}
            >
              暂停
            </Button>
            <Button
              id="cancel-button"
              isDisabled={cancelled || finished}
              onPress={() => {
                stop();
                change((draft) => {
                  if (!hasCandidate(draft.phase)) draft.phase = "cancelled";
                  draft.operator = false;
                  event(draft, "会话已取消");
                });
              }}
            >
              取消会话
            </Button>
          </div>
          <p id="view-caption" role="status">
            {labels[state.phase]}
          </p>
          <Card title="合成文章页面">
            <Badge status="metadata">模拟画面</Badge>
            <article className="sample-article">
              <p>SCIENTIFIC MATERIALS · SYNTHETIC</p>
              <h2>Synthetic research article</h2>
              <p>
                A reproducible demonstration of literature acquisition and
                evidence review.
              </p>
              <p>Alex Researcher · 2026</p>
              <Button
                id="pdf-button"
                isDisabled={
                  !state.operator || candidate || cancelled || running
                }
                onPress={capture}
              >
                View PDF
              </Button>
            </article>
          </Card>
          <p id="observation-text">
            {state.phase === "blocked"
              ? "示例目标地址未通过网络策略检查，尚未接收文件。可以切换其他样本场景后重试，或取消会话。"
              : state.phase === "uncertain"
                ? "标题与目标匹配，但缺少版本证据。"
                : candidate
                  ? "候选不会自动入库，请查看证据后确认。"
                  : "已定位合成文章详情页和 PDF 入口。"}
          </p>
          {narrow ? (
            <Button
              id="mobile-details-button"
              aria-expanded={open}
              onPress={() => setOpen(true)}
            >
              查看候选与证据
            </Button>
          ) : null}
        </section>
        {!narrow ? <aside aria-label="候选与证据">{inspection}</aside> : null}
      </div>
      {narrow ? (
        <Drawer
          title="候选与证据"
          isOpen={open}
          onOpenChange={setOpen}
          footer={
            <Button
              className="mobile-close"
              autoFocus
              onPress={() => setOpen(false)}
            >
              关闭详情
            </Button>
          }
        >
          {inspection}
        </Drawer>
      ) : null}
    </main>
  );
}
const root = document.getElementById("sample-root");
if (!root) throw new Error("Sample root is missing");
createRoot(root).render(
  <MotionProvider>
    <Sample />
  </MotionProvider>,
);
