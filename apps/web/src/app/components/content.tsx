import { errorMessage, localTime, shortTime } from "../strings.js";
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
/**
 * What the shell puts before every page title: on narrow screens the button
 * that opens the navigation drawer, since no bar above the page carries it
 * (design core “页头”).
 */
export const PageHeaderLead = createContext<ReactNode>(null);
/**
 * Page title, an optional context figure ("35,177 篇") and at most one primary
 * action. `description` is only for internal demo pages; product pages express
 * system behaviour through their controls instead.
 */
export function PageHeader({
  title,
  count,
  description,
  action,
}: {
  title: string;
  count?: ReactNode;
  description?: string;
  action?: ReactNode;
}) {
  const lead = useContext(PageHeaderLead);
  return (
    <header className="ui-page-header">
      <div>
        <div className="ui-page-title">
          {lead ? <span className="ui-page-lead">{lead}</span> : null}
          <h1>{title}</h1>
          {count === undefined || count === null ? null : (
            <span className="ui-page-count">{count}</span>
          )}
        </div>
        {description ? <p>{description}</p> : null}
      </div>
      {action}
    </header>
  );
}
/** One sentence about what is missing, plus at most one action. */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  const ended = /[。！？.!?]$/u.test(title);
  return (
    <div className="ui-empty">
      <p>
        <span className="ui-empty-title">{title}</span>
        {description ? (ended ? description : `。${description}`) : null}
      </p>
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
        <p>{errorMessage(new Error(message))}</p>
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
/** A titled page section whose content sits in a soft sunken block, like the library filter panel. */
export function Section({
  title,
  description,
  action,
  footer,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  /** The block's last row, at its bottom right: a section's save and its note. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ui-section">
      <header>
        <div>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {action}
      </header>
      <div className="ui-block">
        {children}
        {footer ? <div className="ui-block-footer">{footer}</div> : null}
      </div>
    </section>
  );
}
export function Definitions({ children }: { children: ReactNode }) {
  return <dl className="ui-definitions">{children}</dl>;
}
/** One setting or property: name and explanation on the left, control and effective value on the right. */
export function Definition({
  term,
  description,
  value,
  children,
}: {
  term: string;
  description?: string;
  value?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="ui-definition">
      <dt>
        {term}
        {description ? <p>{description}</p> : null}
      </dt>
      <dd>
        {children}
        {value ? <span className="ui-definition-value">{value}</span> : null}
      </dd>
    </div>
  );
}
export function Figure({
  number,
  title,
  meta,
  children,
}: {
  number: number;
  title: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <figure className="ui-figure">
      <figcaption>
        <span>
          <span className="ui-figure-number">图 {number}</span>
          <span className="ui-figure-title">{title}</span>
        </span>
        {meta ? <span className="ui-figure-meta">{meta}</span> : null}
      </figcaption>
      <div className="ui-block">{children}</div>
    </figure>
  );
}
type RichTitlePart =
  | string
  | { readonly tag: string; readonly parts: readonly RichTitlePart[] };
/** A literature title with its inline sub/sup/italic markup, already parsed into text parts. */
export function RichTitle({ parts }: { parts: readonly RichTitlePart[] }) {
  return (
    <>
      {parts.map((part, index) =>
        typeof part === "string" ? (
          part
        ) : part.tag === "sub" ? (
          <sub key={index}>
            <RichTitle parts={part.parts} />
          </sub>
        ) : part.tag === "sup" ? (
          <sup key={index}>
            <RichTitle parts={part.parts} />
          </sup>
        ) : part.tag === "b" ? (
          <b key={index}>
            <RichTitle parts={part.parts} />
          </b>
        ) : part.tag === "scp" ? (
          <span key={index} className="title-small-caps">
            <RichTitle parts={part.parts} />
          </span>
        ) : (
          <i key={index}>
            <RichTitle parts={part.parts} />
          </i>
        ),
      )}
    </>
  );
}
export function PageNote({ children }: { children: ReactNode }) {
  return <p className="ui-page-note">{children}</p>;
}
/** A list beside the selected item's detail, framed as one container with two visible panes. */
export function MasterDetail({
  label,
  toolbar,
  list,
  footer,
  detail,
}: {
  label: string;
  toolbar?: ReactNode;
  list: ReactNode;
  footer?: ReactNode;
  detail: ReactNode;
}) {
  return (
    <div className="ui-master-detail">
      <div className="ui-master" role="region" aria-label={label}>
        {toolbar ? <div className="ui-master-toolbar">{toolbar}</div> : null}
        <div className="ui-master-list">{list}</div>
        {footer ? <div className="ui-master-footer">{footer}</div> : null}
      </div>
      <div className="ui-detail">{detail}</div>
    </div>
  );
}
export function MasterGroup({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="ui-master-group">
      <h3>
        {title}
        {count !== undefined ? <span>{count.toLocaleString()}</span> : null}
      </h3>
      {children}
    </section>
  );
}
/** The whole item is clickable, but only the title names the button. */
export function MasterItem({
  title,
  meta,
  badge,
  leading,
  selected = false,
  onPress,
}: {
  title: ReactNode;
  meta?: ReactNode;
  badge?: ReactNode;
  leading?: ReactNode;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <div className="ui-master-item" data-selected={selected || undefined}>
      {leading}
      <div className="ui-master-item-text">
        <button
          type="button"
          className="ui-master-item-open"
          aria-current={selected || undefined}
          onClick={onPress}
        >
          {title}
        </button>
        {meta ? <span className="ui-master-item-meta">{meta}</span> : null}
      </div>
      {badge}
    </div>
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
  /** A newer toast with the same key replaces the shown and queued ones, so its undo always means the latest change. */
  replace?: string;
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
          ...(typeof message !== "string" && message.replace
            ? items.filter((item) => item.replace !== message.replace)
            : items),
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
/** A time written by rule 6, with the full local time on hover. */
export function LocalTime({
  value,
  className,
}: {
  value: unknown;
  className?: string;
}) {
  const date = new Date(String(value));
  const valid = !Number.isNaN(date.getTime());
  return (
    <time
      className={className}
      {...(valid
        ? { dateTime: date.toISOString(), title: localTime(value) }
        : {})}
    >
      {shortTime(value)}
    </time>
  );
}
