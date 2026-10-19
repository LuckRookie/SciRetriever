import { useId, type ReactNode, type RefObject } from "react";
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
import { motion } from "motion/react";
import {
  AnimatedPanel,
  useMotionPreference,
  motionParameters,
} from "../motion/index.js";
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
}
function TabNavigation({
  label,
  value,
  onChange,
  items,
  children,
  segmented,
}: TabsProps & { segmented: boolean }) {
  const id = useId();
  const { reduced } = useMotionPreference();
  return (
    <AriaTabs
      className={segmented ? "ui-segmented" : "ui-tabs"}
      selectedKey={value}
      onSelectionChange={(key) => onChange(String(key))}
      disabledKeys={items
        .filter((item) => item.disabled)
        .map((item) => item.id)}
    >
      <TabList aria-label={label} className="ui-tab-list">
        {items.map((item) => (
          <Tab key={item.id} id={item.id} className="ui-tab">
            {({ isSelected }) => (
              <>
                {isSelected ? (
                  <motion.span
                    className="ui-tab-indicator"
                    layoutId={`${id}-indicator`}
                    transition={
                      reduced
                        ? { duration: 0 }
                        : { type: "spring", ...motionParameters.spring }
                    }
                  />
                ) : null}
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
  ready: ["green", "内容已就绪"],
  running: ["yellow", "进行中"],
  partial: ["yellow", "部分完成"],
  completed: ["green", "完成"],
  failed: ["red", "失败"],
  unavailable: ["red", "无法获取"],
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
  onAction: () => void;
  disabled?: boolean;
  description?: string;
  shortcut?: string;
}
export function Menu({
  label,
  items,
  icon,
}: {
  label: string;
  items: readonly MenuOption[];
  icon?: ReactNode;
}) {
  return (
    <AriaMenuTrigger>
      <Button {...(icon ? { icon } : {})}>{label}</Button>
      <AriaPopover className="ui-popover" placement="bottom end">
        <AriaMenu
          className="ui-menu"
          aria-label={label}
          items={items}
          disabledKeys={items
            .filter((item) => item.disabled)
            .map((item) => item.id)}
        >
          {(item) => (
            <MenuItem
              id={item.id}
              className="ui-menu-item"
              textValue={item.label}
              onAction={item.onAction}
            >
              <Text slot="label">{item.label}</Text>
              {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
              {item.description ? (
                <Text slot="description" className="ui-description">
                  {item.description}
                </Text>
              ) : null}
            </MenuItem>
          )}
        </AriaMenu>
      </AriaPopover>
    </AriaMenuTrigger>
  );
}
export { AriaMenuTrigger as MenuTrigger };
export function Popover({
  label,
  children,
  trigger,
}: {
  label: string;
  children: ReactNode;
  trigger?: ReactNode;
}) {
  return (
    <DialogTrigger>
      <Button variant="text">{trigger ?? label}</Button>
      <AriaPopover
        className="ui-popover ui-evidence-popover"
        placement="bottom"
      >
        <Dialog aria-label={label} className="ui-popover-content">
          {children}
        </Dialog>
      </AriaPopover>
    </DialogTrigger>
  );
}
/** For trusted engine-owned anchors whose DOM cannot be wrapped by DialogTrigger. */
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
  return (
    <AriaPopover
      className="ui-popover ui-evidence-popover"
      placement="bottom"
      triggerRef={triggerRef}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isNonModal
    >
      <Dialog aria-label={label} className="ui-popover-content">
        {children}
      </Dialog>
    </AriaPopover>
  );
}
export function Tooltip({
  text,
  children,
}: {
  text: string;
  children: ReactNode;
}) {
  return (
    <TooltipTrigger delay={500} closeDelay={0}>
      {children}
      <AriaTooltip className="ui-tooltip">{text}</AriaTooltip>
    </TooltipTrigger>
  );
}
