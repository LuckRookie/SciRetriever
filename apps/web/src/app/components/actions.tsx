import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  Heading,
  Modal,
  ModalOverlay,
  Tooltip as AriaTooltip,
  TooltipTrigger,
  type ButtonProps as AriaButtonProps,
} from "react-aria-components";
import { AnimatedPanel } from "../motion/index.js";
import { Icon } from "./icons.js";
export interface ConfirmOptions {
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  scope?: string;
  service?: string;
}
export interface ButtonProps
  extends Omit<
    AriaButtonProps,
    "className" | "children" | "onPress" | "isPending"
  > {
  children?: ReactNode;
  className?: string;
  variant?: "primary" | "secondary" | "text" | "danger" | "process";
  size?: "normal" | "compact" | "inline";
  icon?: ReactNode;
  isPending?: boolean;
  disabledReason?: string | undefined;
  onPress?: () => void | Promise<void>;
  confirm?: ConfirmOptions | false;
}
export function Button({
  children,
  className = "",
  variant = "secondary",
  size = "normal",
  icon,
  isPending = false,
  isDisabled = false,
  disabledReason,
  onPress,
  confirm,
  ...props
}: ButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [prolonged, setProlonged] = useState(false);
  const working = isPending || pending;
  useEffect(() => {
    if (!working) {
      setProlonged(false);
      return;
    }
    const timer = setTimeout(() => setProlonged(true), 1000);
    return () => clearTimeout(timer);
  }, [working]);
  const busy = useRef(false);
  const disabled = isDisabled || !!disabledReason;
  const reason = useId();
  const confirmation = confirm || undefined;
  const perform = async () => {
    if (busy.current || isPending || disabled) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await onPress?.();
      setConfirming(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作未完成，请重试。");
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const click = () => {
    if (confirm !== false && (confirm || variant === "process"))
      setConfirming(true);
    else void perform();
  };
  const button = (
    <AriaButton
      {...props}
      className={`ui-button ${className}`}
      data-variant={variant}
      data-size={size}
      isDisabled={disabled}
      isPending={isPending || pending}
      aria-busy={isPending || pending}
      {...(disabledReason ? { "aria-describedby": reason } : {})}
      onPress={click}
    >
      {icon}
      <span className="ui-button-label">{children}</span>
      {working ? (
        <span className="ui-button-pending" aria-hidden="true">
          <span className="ui-spinner" />
          {prolonged ? (
            <span className="ui-button-pending-label">正在提交…</span>
          ) : null}
        </span>
      ) : null}
    </AriaButton>
  );
  return (
    <>
      {disabledReason && disabled ? (
        <span
          className="ui-disabled-action"
          tabIndex={0}
          aria-describedby={reason}
        >
          {button}
          <span className="ui-disabled-reason" id={reason}>
            {disabledReason}
          </span>
        </span>
      ) : (
        button
      )}
      {error && !confirming ? (
        <span className="ui-action-error" role="alert">
          {error}
        </span>
      ) : null}
      <ConfirmDialog
        isOpen={confirming}
        onOpenChange={setConfirming}
        title={confirmation?.title ?? "确认加工"}
        description={
          confirmation?.description ??
          "这项操作将处理已选择的材料，请确认后继续。"
        }
        {...(confirmation?.scope ? { scope: confirmation.scope } : {})}
        {...(confirmation?.service ? { service: confirmation.service } : {})}
        confirmLabel={confirmation?.confirmLabel ?? "确认执行"}
        isPending={pending}
        errorMessage={error}
        onConfirm={perform}
      />
    </>
  );
}
export function IconButton({
  "aria-label": label,
  children,
  ...props
}: ButtonProps & { "aria-label": string }) {
  return (
    <TooltipTrigger delay={500} closeDelay={0}>
      <Button
        {...props}
        aria-label={label}
        className={`ui-icon-button ${props.className ?? ""}`}
      >
        {children}
      </Button>
      <AriaTooltip className="ui-tooltip" placement="bottom">
        {label}
      </AriaTooltip>
    </TooltipTrigger>
  );
}
export interface DialogProps {
  title: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  footer?: ReactNode;
  isDismissable?: boolean;
  className?: string;
}
export function Dialog({
  title,
  isOpen,
  onOpenChange,
  children,
  footer,
  isDismissable = true,
  className = "",
}: DialogProps) {
  return (
    <ModalOverlay
      className="ui-overlay"
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={isDismissable}
      isKeyboardDismissDisabled={!isDismissable}
    >
      <Modal className={`ui-modal ${className}`}>
        <AriaDialog className="ui-dialog">
          <AnimatedPanel preset="dialog">
            <header className="ui-dialog-header">
              <Heading slot="title">{title}</Heading>
              <AriaButton
                className="ui-button ui-icon-button"
                data-variant="text"
                aria-label="关闭对话框"
                isDisabled={!isDismissable}
                onPress={() => onOpenChange(false)}
              >
                <Icon name="close" />
              </AriaButton>
            </header>
            <div className="ui-dialog-body">{children}</div>
            {footer ? (
              <footer className="ui-dialog-footer">{footer}</footer>
            ) : null}
          </AnimatedPanel>
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
export function ConfirmDialog({
  title,
  description,
  scope,
  service,
  isOpen,
  onOpenChange,
  onConfirm,
  confirmLabel = "确认执行",
  isPending = false,
  errorMessage,
}: ConfirmOptions & {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
  isPending?: boolean;
  errorMessage?: string;
}) {
  return (
    <Dialog
      title={title}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={!isPending}
      footer={
        <>
          <AriaButton
            className="ui-button"
            data-variant="secondary"
            isDisabled={isPending}
            onPress={() => onOpenChange(false)}
          >
            取消
          </AriaButton>
          <AriaButton
            className="ui-button"
            data-variant="primary"
            isDisabled={isPending}
            aria-busy={isPending}
            onPress={() => {
              void onConfirm();
            }}
          >
            {isPending ? (
              <span className="ui-spinner" aria-hidden="true" />
            ) : null}
            {isPending ? "正在提交…" : confirmLabel}
          </AriaButton>
        </>
      }
    >
      <div className="ui-confirm-description">{description}</div>
      {scope ? <p>处理范围：{scope}</p> : null}
      {service ? <p>使用服务：{service}</p> : null}
      {errorMessage ? (
        <p className="ui-error-text" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </Dialog>
  );
}
export function Drawer({
  title,
  isOpen,
  onOpenChange,
  children,
  footer,
  isDismissable = true,
}: DialogProps) {
  return (
    <ModalOverlay
      className="ui-overlay ui-drawer-overlay"
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={isDismissable}
      isKeyboardDismissDisabled={!isDismissable}
    >
      <Modal className="ui-drawer">
        <AriaDialog className="ui-dialog">
          <AnimatedPanel preset="drawer">
            <header className="ui-dialog-header">
              <Heading slot="title">{title}</Heading>
              <AriaButton
                className="ui-button ui-icon-button"
                data-variant="text"
                aria-label="关闭抽屉"
                isDisabled={!isDismissable}
                onPress={() => onOpenChange(false)}
              >
                <Icon name="close" />
              </AriaButton>
            </header>
            <div className="ui-dialog-body">{children}</div>
            {footer ? (
              <footer className="ui-dialog-footer">{footer}</footer>
            ) : null}
          </AnimatedPanel>
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
