import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Button as AriaButton,
  Dialog,
  DialogTrigger,
  Disclosure as AriaDisclosure,
  DisclosurePanel,
  Heading,
  Menu as AriaMenu,
  MenuItem,
  MenuTrigger as AriaMenuTrigger,
  SubmenuTrigger,
  Popover as AriaPopover,
  Tab,
  TabList,
  TabPanel,
  Tabs as AriaTabs,
  Text,
  ToggleButton,
  Tooltip as AriaTooltip,
  TooltipTrigger,
} from "react-aria-components";
import { AnimatedPanel, useMotionPreference } from "../motion/index.js";
import { Icon } from "./icons.js";
import { Button, IconButton } from "./actions.js";
export interface TabItem {
  id: string;
  label: ReactNode;
  disabled?: boolean;
}
export interface TabsProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  items: readonly TabItem[];
  children?: ReactNode;
  /** Vertical tabs list sections down the side of a page, as in settings. */
  orientation?: "horizontal" | "vertical";
}
function TabNavigation({
  label,
  value,
  onChange,
  items,
  children,
  segmented,
  orientation = "horizontal",
}: TabsProps & { segmented: boolean }) {
  const { reduced } = useMotionPreference();
  const root = useRef<HTMLDivElement>(null);
  const from = useRef<DOMRect | null>(null);
  const indicator = () =>
    root.current?.querySelector<HTMLElement>(
      ".ui-tab[data-selected] .ui-tab-indicator",
    );
  // The indicator glides from the old tab only when the selection changes, so
  // the page is measured once per change instead of on every render.
  useLayoutEffect(() => {
    const before = from.current,
      now = indicator();
    from.current = null;
    if (!before || !now || reduced) return;
    const after = now.getBoundingClientRect();
    if (!after.width || !after.height) return;
    now.animate(
      [
        {
          transformOrigin: "0 0",
          transform: `translate(${before.left - after.left}px, ${before.top - after.top}px) scale(${before.width / after.width}, ${before.height / after.height})`,
        },
        { transformOrigin: "0 0", transform: "none" },
      ],
      { duration: 220, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    );
  }, [value, reduced]);
  return (
    <AriaTabs
      ref={root}
      className={segmented ? "ui-segmented" : "ui-tabs"}
      orientation={orientation}
      selectedKey={value}
      onSelectionChange={(key) => {
        from.current = indicator()?.getBoundingClientRect() ?? null;
        onChange(String(key));
      }}
      disabledKeys={items
        .filter((item) => item.disabled)
        .map((item) => item.id)}
    >
      <TabList aria-label={label} className="ui-tab-list">
        {items.map((item) => (
          <Tab key={item.id} id={item.id} className="ui-tab">
            {({ isSelected }) => (
              <>
                {isSelected ? <span className="ui-tab-indicator" /> : null}
                <span className="ui-tab-label">{item.label}</span>
              </>
            )}
          </Tab>
        ))}
      </TabList>
      {children ? (
        <TabPanel id={value} className="ui-tab-panel">
          {children}
        </TabPanel>
      ) : null}
    </AriaTabs>
  );
}
export function Tabs(props: TabsProps) {
  return <TabNavigation {...props} segmented={false} />;
}
export function SegmentedControl(props: TabsProps) {
  return <TabNavigation {...props} segmented />;
}
export function FilterChip({
  children,
  isSelected,
  onChange,
  count,
  onRemove,
  isDisabled = false,
}: {
  children: ReactNode;
  isSelected: boolean;
  onChange: (selected: boolean) => void;
  count?: number;
  onRemove?: () => void;
  isDisabled?: boolean;
}) {
  return (
    <span className="ui-filter-group">
      <ToggleButton
        className="ui-filter"
        isSelected={isSelected}
        onChange={onChange}
        isDisabled={isDisabled}
      >
        {children}
        {count === undefined ? null : <span className="ui-count">{count}</span>}
      </ToggleButton>
      {onRemove ? (
        <IconButton
          aria-label={`移除${typeof children === "string" ? children : "筛选"}`}
          size="inline"
          variant="text"
          onPress={onRemove}
        >
          <Icon name="close" />
        </IconButton>
      ) : null}
    </span>
  );
}
export function ChipGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className="ui-chip-group">
      {children}
    </div>
  );
}
export type BadgeStatus =
  | "metadata"
  | "pdf"
  | "ready"
  | "running"
  | "partial"
  | "completed"
  | "failed"
  | "unavailable";
const badges: Record<BadgeStatus, readonly [string, string]> = {
  metadata: ["gray", "仅元数据"],
  pdf: ["blue", "有 PDF"],
  ready: ["green", "已就绪"],
  running: ["yellow", "进行中"],
  partial: ["yellow", "部分完成"],
  completed: ["green", "完成"],
  failed: ["red", "失败"],
  unavailable: ["purple", "无法获取"],
};
export function Badge({
  status,
  children,
}: {
  status: BadgeStatus;
  children?: ReactNode;
}) {
  const [color, label] = badges[status];
  return (
    <span className="ui-badge" data-color={color}>
      <span aria-hidden="true" />
      {children ?? label}
    </span>
  );
}
export function Disclosure({
  title,
  children,
  defaultExpanded = false,
}: {
  title: ReactNode;
  children: ReactNode;
  defaultExpanded?: boolean;
}) {
  return (
    <AriaDisclosure className="ui-disclosure" defaultExpanded={defaultExpanded}>
      {({ isExpanded }) => (
        <>
          <Heading>
            <AriaButton slot="trigger" className="ui-disclosure-trigger">
              <Icon name="chevron" />
              {title}
            </AriaButton>
          </Heading>
          <DisclosurePanel className="ui-disclosure-panel">
            <AnimatedPanel
              preset="collapse"
              active={isExpanded}
              layout
              maxAnimatedHeight={480}
            >
              {children}
            </AnimatedPanel>
          </DisclosurePanel>
        </>
      )}
    </AriaDisclosure>
  );
}
export interface MenuOption {
  id: string;
  label: string;
  /** Not called for an item that opens a submenu. */
  onAction: () => void;
  /** A choice or switch that is on: a check mark after the label. */
  checked?: boolean;
  /** Opens a further menu beside this item instead of acting. */
  submenu?: readonly MenuOption[];
  disabled?: boolean;
  description?: string;
  shortcut?: string;
  /** A visual mark after the label in place of a shortcut, such as a colour dot. */
  trailing?: ReactNode;
  /** Start a new group of items with a hairline above this one. */
  divider?: boolean;
}
export function Menu({
  label,
  items,
  icon,
  indicator = false,
  variant,
  iconOnly = false,
  className,
}: {
  label: string;
  items: readonly MenuOption[];
  icon?: ReactNode;
  /** Show a trailing chevron so a text trigger reads as a menu. */
  indicator?: boolean;
  variant?: "secondary" | "text";
  /** Render the trigger as a compact icon button; the label names it. */
  iconOnly?: boolean;
  className?: string;
}) {
  return (
    <AriaMenuTrigger>
      {iconOnly ? (
        <IconButton
          aria-label={label}
          size="inline"
          variant="text"
          icon={icon ?? <Icon name="more" />}
          {...(className ? { className } : {})}
        />
      ) : (
        <Button
          {...(icon ? { icon } : {})}
          {...(variant ? { variant } : {})}
          {...(className ? { className } : {})}
        >
          {label}
          {indicator ? <Icon name="chevron" /> : null}
        </Button>
      )}
      <AriaPopover className="ui-popover" placement="bottom end">
        <MenuItems label={label} items={items} />
      </AriaPopover>
    </AriaMenuTrigger>
  );
}
function MenuItems({
  label,
  items,
}: {
  label: string;
  items: readonly MenuOption[];
}) {
  return (
    <AriaMenu
      className="ui-menu"
      aria-label={label}
      items={items}
      disabledKeys={items
        .filter((item) => item.disabled)
        .map((item) => item.id)}
    >
      {(item) => {
        const row = (
          <MenuItem
            // Inside a submenu trigger the trigger node carries the item's id.
            id={item.submenu ? `${item.id}:open` : item.id}
            className="ui-menu-item"
            data-divider={item.divider || undefined}
            data-checked={item.checked || undefined}
            textValue={item.label}
            {...(item.submenu ? {} : { onAction: item.onAction })}
          >
            <Text slot="label">{item.label}</Text>
            {item.submenu ? (
              <Icon name="chevron" />
            ) : (
              (item.trailing ??
              (item.shortcut ? <kbd>{item.shortcut}</kbd> : null))
            )}
            {item.description ? (
              <Text slot="description" className="ui-description">
                {item.description}
              </Text>
            ) : null}
          </MenuItem>
        );
        return item.submenu ? (
          <SubmenuTrigger>
            {row}
            <AriaPopover className="ui-popover" placement="end top">
              <MenuItems label={item.label} items={item.submenu} />
            </AriaPopover>
          </SubmenuTrigger>
        ) : (
          row
        );
      }}
    </AriaMenu>
  );
}
export { AriaMenuTrigger as MenuTrigger };
function usePreviewBoundary(anchor: RefObject<Element | null>, open: boolean) {
  const [boundary, setBoundary] = useState<HTMLElement>();
  const [size, setSize] = useState<{
    width: number;
    maxWidth: number;
    maxHeight: number;
  }>();
  useLayoutEffect(() => {
    if (!open) return;
    const element = anchor.current?.closest<HTMLElement>(
      ".reader-surface, .react-reader",
    );
    if (!element) return;
    setBoundary(element);
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setSize({
        width: Math.max(0, Math.min(400, rect.width - 16)),
        maxWidth: Math.max(0, Math.min(400, rect.width - 16)),
        maxHeight: Math.max(
          0,
          Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top) - 16,
        ),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [anchor, open]);
  return {
    ...(boundary ? { boundaryElement: boundary } : {}),
    ...(size
      ? {
          maxHeight: size.maxHeight,
          style: { width: size.width, maxWidth: size.maxWidth },
        }
      : {}),
  };
}
export function Popover({
  label,
  children,
  trigger,
}: {
  label: string;
  children: ReactNode;
  trigger?: ReactNode;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const boundary = usePreviewBoundary(anchor, open);
  useEffect(() => {
    if (!open) return;
    // Escape also works when resize or async content leaves focus on the trigger.
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("keydown", dismiss, true);
    return () => document.removeEventListener("keydown", dismiss, true);
  }, [open]);
  return (
    <span ref={anchor} className="ui-popover-trigger">
      <DialogTrigger isOpen={open} onOpenChange={setOpen}>
        <Button variant="text">{trigger ?? label}</Button>
        <AriaPopover
          className="ui-popover ui-evidence-popover"
          placement="bottom"
          containerPadding={8}
          {...boundary}
        >
          <Dialog aria-label={label} className="ui-popover-content">
            <div className="ui-popover-actions">
              <Button
                variant="text"
                size="compact"
                onPress={() => setOpen(false)}
              >
                关闭预览
              </Button>
            </div>
            {children}
          </Dialog>
        </AriaPopover>
      </DialogTrigger>
    </span>
  );
}
/** Engine-owned hover previews keep focus on their anchor; nested modal Dialog autofocus would close them during pointer entry. */
export function AnchoredPopover({
  label,
  isOpen,
  onOpenChange,
  triggerRef,
  children,
}: {
  label: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<Element | null>;
  children: ReactNode;
}) {
  const boundary = usePreviewBoundary(triggerRef, isOpen);
  return (
    <AriaPopover
      className="ui-popover ui-evidence-popover"
      placement="bottom"
      containerPadding={8}
      {...boundary}
      trigger="PreviewTrigger"
      aria-label={label}
      triggerRef={triggerRef}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isNonModal
    >
      <div className="ui-popover-content">{children}</div>
    </AriaPopover>
  );
}
export function Tooltip({
  text,
  wide = false,
  children,
}: {
  /** Short hint text, or a small read-only preview when `wide`. */
  text: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <TooltipTrigger delay={500} closeDelay={0}>
      {children}
      <AriaTooltip
        className={wide ? "ui-tooltip ui-tooltip-wide" : "ui-tooltip"}
        {...(wide ? { placement: "bottom start" as const } : {})}
      >
        {text}
      </AriaTooltip>
    </TooltipTrigger>
  );
}
