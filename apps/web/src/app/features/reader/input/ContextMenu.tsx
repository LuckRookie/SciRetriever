import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Button as AriaButton,
  MenuTrigger as AriaMenuTrigger,
  Popover as AriaPopover,
} from "react-aria-components";
import { MenuItems, type MenuOption } from "../../../components/index.js";
import { menuPosition } from "./context-menu.js";

export interface ContextMenuRequest {
  /** Where it opens: the pointer, or for the keyboard the object's corner. */
  x: number;
  y: number;
  label: string;
  items: readonly MenuOption[];
  /** Opened by the keyboard: focus goes to the first item. */
  keyboard: boolean;
}
/**
 * One context menu (reading-experience 1.8.2), with the look of every menu:
 * its top-left corner at the point, opening down and right, turned left or
 * up where it does not fit, 8 px from the viewport's edges. It closes on a
 * press outside (the press goes no further), a scroll of the reading area,
 * the window losing focus or changing size. A second right-click elsewhere
 * builds it anew there (`onRetarget`); one on the menu itself does nothing.
 */
export function ContextMenu({
  request,
  onClose,
  onRetarget,
}: {
  request: ContextMenuRequest | null;
  onClose: () => void;
  onRetarget: (event: MouseEvent, element: Element | null) => void;
}) {
  const [place, setPlace] = useState<{
    left: number;
    top: number;
    maxHeight: number;
  } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose),
    retarget = useRef(onRetarget);
  close.current = onClose;
  retarget.current = onRetarget;
  useLayoutEffect(() => setPlace(null), [request]);
  // Measured once its items are drawn (the popover and the menu's items
  // arrive over a frame or two), then placed by spec 1.8.2's rules.
  useLayoutEffect(() => {
    if (!request || place) return;
    let frame = 0;
    const measure = () => {
      const popover = document.querySelector<HTMLElement>(".ui-context-menu"),
        menu = popover?.querySelector<HTMLElement>(".ui-menu");
      if (!popover || !menu?.querySelector("[role='menuitem']")) {
        frame = requestAnimationFrame(measure);
        return;
      }
      const width = popover.offsetWidth,
        height = popover.offsetHeight - menu.clientHeight + menu.scrollHeight;
      setPlace(
        menuPosition(
          { x: request.x, y: request.y },
          { width, height },
          { width: innerWidth, height: innerHeight },
        ),
      );
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [request, place]);
  useEffect(() => {
    if (!request) return;
    const shut = () => close.current();
    const wheel = (event: WheelEvent) => {
      // A wheel turned over the menu scrolls it; elsewhere it closes it.
      if ((event.target as Element | null)?.closest?.(".ui-context-menu"))
        return;
      shut();
    };
    const again = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.(".ui-context-menu")) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey) return shut();
      event.preventDefault();
      // The underlay is on top: the element beneath it is the new target.
      const beneath =
        document
          .elementsFromPoint(event.clientX, event.clientY)
          .find(
            (el) =>
              !el.closest(".ui-context-menu") &&
              !(el as HTMLElement).dataset?.testid &&
              el !== trigger.current,
          ) ?? null;
      retarget.current(event, beneath);
    };
    addEventListener("wheel", wheel, { capture: true, passive: true });
    addEventListener("blur", shut);
    addEventListener("resize", shut);
    addEventListener("contextmenu", again, true);
    return () => {
      removeEventListener("wheel", wheel, { capture: true });
      removeEventListener("blur", shut);
      removeEventListener("resize", shut);
      removeEventListener("contextmenu", again, true);
    };
  }, [request]);
  if (!request) return null;
  return (
    <AriaMenuTrigger
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AriaButton
        ref={trigger}
        aria-hidden
        excludeFromTabOrder
        className="ui-context-menu-point"
        style={{
          left: place?.left ?? request.x,
          top: place?.top ?? request.y,
        }}
      />
      <AriaPopover
        className="ui-popover ui-context-menu"
        placement="bottom start"
        offset={0}
        shouldFlip={false}
        containerPadding={8}
        {...(place ? { maxHeight: place.maxHeight } : {})}
        // Unseen until placed, yet focusable: the menu takes the focus at once.
        {...(place ? {} : { style: { opacity: 0 } })}
      >
        <MenuItems
          label={request.label}
          items={request.items}
          autoFocus={request.keyboard ? "first" : true}
        />
      </AriaPopover>
    </AriaMenuTrigger>
  );
}
