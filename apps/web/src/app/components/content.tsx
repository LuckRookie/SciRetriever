import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button, IconButton } from "./actions.js";
import { Icon } from "./icons.js";
import { Disclosure } from "./navigation.js";
import { AnimatedPanel, Presence } from "../motion/index.js";
export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="ui-page-header">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {action}
    </header>
  );
}
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="ui-empty">
      <p className="ui-empty-title">{title}</p>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}
export function ErrorNotice({
  message,
  retained,
  onRetry,
}: {
  message: string;
  retained?: string;
  onRetry?: () => void | Promise<void>;
}) {
  return (
    <div className="ui-error-notice" role="alert">
      <Icon name="warning" />
      <div>
        <p>{message}</p>
        {retained ? <p className="ui-description">{retained}</p> : null}
        {onRetry ? (
          <Button size="compact" onPress={onRetry}>
            重试
          </Button>
        ) : null}
      </div>
    </div>
  );
}
export function Skeleton({
  label = "正在读取",
  rows = 3,
}: {
  label?: string;
  rows?: number;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 300);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div
      className="ui-skeleton"
      role="status"
      aria-label={label}
      aria-busy="true"
      data-visible={visible}
    >
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} />
      ))}
    </div>
  );
}
export function Card({
  title,
  children,
  action,
}: {
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="ui-card">
      {title ? (
        <header>
          <h2>{title}</h2>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}
export function ListRow({
  title,
  bibliography,
  badge,
  leading,
  action,
  onPress,
}: {
  title: ReactNode;
  bibliography?: ReactNode;
  badge?: ReactNode;
  leading?: ReactNode;
  action?: ReactNode;
  onPress?: () => void;
}) {
  return (
    <div className="ui-list-row">
      {leading}
      <div className="ui-list-row-content">
        {onPress ? (
          <Button variant="text" onPress={onPress}>
            {title}
          </Button>
        ) : (
          <div className="ui-list-row-title">{title}</div>
        )}
        {bibliography ? (
          <div className="ui-list-row-bibliography">{bibliography}</div>
        ) : null}
      </div>
      {badge}
      {action}
    </div>
  );
}
async function copy(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      /* The user initiated HTTP fallback below stays explicit. */
    }
  }
  const prior = document.activeElement;
  const input = document.createElement("textarea");
  input.value = value;
  input.className = "ui-clipboard";
  document.body.append(input);
  input.select();
  try {
    if (!document.execCommand("copy"))
      throw new Error("浏览器未允许复制，请选择内容后复制。");
  } finally {
    input.remove();
    if (prior instanceof HTMLElement) prior.focus();
  }
}
export function TechDetails({
  children,
  copyText,
  title = "技术详情",
}: {
  children: ReactNode;
  copyText?: string;
  title?: string;
}) {
  return (
    <Disclosure title={title}>
      <div className="ui-tech-details">
        {children}
        {copyText ? (
          <Button
            size="compact"
            icon={<Icon name="copy" />}
            onPress={() => copy(copyText)}
          >
            复制技术信息
          </Button>
        ) : null}
      </div>
    </Disclosure>
  );
}
export interface ToastMessage {
  message: string;
  action?: { label: string; onPress: () => void };
}
interface QueuedToast extends ToastMessage {
  id: number;
}
const ToastContext = createContext<(message: ToastMessage | string) => void>(
  () => {},
);
export function useToast() {
  return useContext(ToastContext);
}
export function ToastProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<QueuedToast[]>([]);
  const next = useRef(0);
  const current = queue[0];
  const [paused, setPaused] = useState(false);
  const remove = () => setQueue((items) => items.slice(1));
  useEffect(() => {
    if (!current || paused) return;
    const timer = setTimeout(() => setQueue((items) => items.slice(1)), 4000);
    return () => clearTimeout(timer);
  }, [current, paused]);
  return (
    <ToastContext.Provider
      value={(message) =>
        setQueue((items) => [
          ...items,
          {
            ...(typeof message === "string" ? { message } : message),
            id: ++next.current,
          },
        ])
      }
    >
      {children}
      <div className="ui-toast-region" aria-live="polite" aria-atomic="true">
        <Presence>
          {current ? (
            <AnimatedPanel key={current.id} preset="toast">
              <div
                className="ui-toast"
                onMouseEnter={() => setPaused(true)}
                onMouseLeave={() => setPaused(false)}
                onFocus={() => setPaused(true)}
                onBlur={() => setPaused(false)}
              >
                <span>{current.message}</span>
                {current.action ? (
                  <Button
                    variant="text"
                    size="compact"
                    onPress={() => {
                      current.action?.onPress();
                      remove();
                    }}
                  >
                    {current.action.label}
                  </Button>
                ) : null}
                <IconButton
                  aria-label="关闭提示"
                  variant="text"
                  size="inline"
                  onPress={remove}
                >
                  <Icon name="close" />
                </IconButton>
              </div>
            </AnimatedPanel>
          ) : null}
        </Presence>
      </div>
    </ToastContext.Provider>
  );
}
export const Toast = ToastProvider;
export function SplitPane({
  label,
  children,
  side,
  width,
  onWidthChange,
  min = 200,
  max = 520,
  defaultWidth = 280,
  edge = "right",
}: {
  label: string;
  children: ReactNode;
  side: ReactNode;
  width: number;
  onWidthChange: (width: number) => void;
  min?: number;
  max?: number;
  defaultWidth?: number;
  edge?: "right" | "left";
}) {
  const panel = useRef<HTMLDivElement>(null);
  const active = useRef<{ x: number; width: number } | null>(null);
  const id = useId();
  const clamp = (value: number) => Math.min(max, Math.max(min, value));
  return (
    <div
      className="ui-split-pane"
      data-edge={edge}
      style={{
        gridTemplateColumns:
          edge === "right"
            ? `${width}px minmax(0, 1fr)`
            : `minmax(0, 1fr) ${width}px`,
      }}
    >
      <div ref={panel} id={id} className="ui-split-side">
        {side}
        <div
          role="separator"
          aria-label={label}
          aria-orientation="vertical"
          aria-controls={id}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={width}
          tabIndex={0}
          className="ui-split-handle"
          onDoubleClick={() => onWidthChange(clamp(defaultWidth))}
          onKeyDown={(event) => {
            if (event.key === "Home") {
              event.preventDefault();
              onWidthChange(clamp(defaultWidth));
            }
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              onWidthChange(
                clamp(
                  width +
                    (event.key === "ArrowRight" ? 16 : -16) *
                      (edge === "right" ? 1 : -1),
                ),
              );
            }
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            active.current = { x: event.clientX, width };
          }}
          onPointerMove={(event) => {
            if (active.current)
              onWidthChange(
                clamp(
                  active.current.width +
                    (event.clientX - active.current.x) *
                      (edge === "right" ? 1 : -1),
                ),
              );
          }}
          onPointerUp={(event) => {
            active.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            active.current = null;
          }}
        />
      </div>
      <div className="ui-split-main">{children}</div>
    </div>
  );
}
