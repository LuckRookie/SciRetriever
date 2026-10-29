import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  AnimatePresence,
  MotionConfig,
  motion,
  useAnimationControls,
  type Variants,
} from "motion/react";

export type MotionPreference = "system" | "reduced" | "full";
interface MotionState {
  preference: MotionPreference;
  reduced: boolean;
  setPreference: (value: MotionPreference) => void;
}
const Context = createContext<MotionState>({
  preference: "system",
  reduced: false,
  setPreference: () => {},
});
export function MotionProvider({
  children,
  preference = "system",
  onPreferenceChange,
}: {
  children: ReactNode;
  preference?: MotionPreference;
  onPreferenceChange?: (value: MotionPreference) => void;
}) {
  const [choice, setChoice] = useState(preference);
  const [system, setSystem] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    setChoice(preference);
  }, [preference]);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => setSystem(media.matches);
    const visibility = () => setHidden(document.hidden);
    media.addEventListener("change", changed);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      media.removeEventListener("change", changed);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  const reduced =
    hidden || choice === "reduced" || (choice === "system" && system);
  useEffect(() => {
    document.documentElement.dataset.reducedMotion = String(reduced);
  }, [reduced]);
  const value = useMemo(
    () => ({
      preference: choice,
      reduced,
      setPreference: (next: MotionPreference) => {
        setChoice(next);
        onPreferenceChange?.(next);
      },
    }),
    [choice, reduced, onPreferenceChange],
  );
  return (
    <Context.Provider value={value}>
      <MotionConfig reducedMotion={reduced ? "always" : "never"}>
        {children}
      </MotionConfig>
    </Context.Provider>
  );
}
export function useMotionPreference() {
  return useContext(Context);
}
export const motionParameters = Object.freeze({
  press: 0.98,
  spring: { stiffness: 520, damping: 38, mass: 0.7 },
  fast: 0.12,
  normal: 0.18,
  panel: 0.24,
  exitRatio: 2 / 3,
  evidence: 0.9,
});
export type MotionPreset =
  | "press"
  | "indicator"
  | "popover"
  | "dialog"
  | "drawer"
  | "panelContent"
  | "collapse"
  | "toast"
  | "highlight"
  | "listItem"
  | "fadeIn";
const ease = [0.2, 0, 0, 1] as const;
export const presets: Record<MotionPreset, Variants> = {
  press: {
    initial: { scale: 1 },
    visible: { scale: 1 },
    exit: { scale: 0.98 },
  },
  indicator: {
    initial: { opacity: 1 },
    visible: { opacity: 1 },
    exit: { opacity: 0 },
  },
  popover: {
    initial: { opacity: 0, y: 4, scale: 0.98 },
    visible: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, y: 2, scale: 0.98 },
  },
  dialog: {
    initial: { opacity: 0, scale: 0.98 },
    visible: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.98 },
  },
  drawer: {
    initial: { opacity: 0, x: 8 },
    visible: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: 8 },
  },
  panelContent: {
    initial: { opacity: 0, x: 8 },
    visible: { opacity: 1, x: 0 },
    exit: { opacity: 0 },
  },
  collapse: {
    initial: { opacity: 0, y: -4 },
    visible: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -4 },
  },
  toast: {
    initial: { opacity: 0, y: 8 },
    visible: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: 8 },
  },
  highlight: {
    initial: { backgroundColor: "var(--mark)" },
    visible: { backgroundColor: "var(--mark-soft)" },
    exit: {},
  },
  listItem: {
    initial: { opacity: 1 },
    visible: { opacity: 1 },
    exit: { opacity: 0 },
  },
  fadeIn: {
    initial: { opacity: 0 },
    visible: { opacity: 1 },
    exit: { opacity: 0 },
  },
};
export function Presence({ children }: { children: ReactNode }) {
  return (
    <AnimatePresence initial={false} mode="sync">
      {children}
    </AnimatePresence>
  );
}
export function AnimatedPanel({
  children,
  preset = "panelContent",
  className,
  layout = false,
  active,
  maxAnimatedHeight,
}: {
  children: ReactNode;
  preset?: MotionPreset;
  className?: string | undefined;
  layout?: boolean;
  active?: boolean;
  maxAnimatedHeight?: number;
}) {
  const { reduced } = useMotionPreference();
  const element = useRef<HTMLDivElement>(null);
  const [oversized, setOversized] = useState(false);
  useLayoutEffect(() => {
    if (maxAnimatedHeight == null || active === false || !element.current)
      return;
    const current = element.current;
    const measure = () => {
      if (current.scrollHeight > 0)
        setOversized(current.scrollHeight > maxAnimatedHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(current);
    return () => observer.disconnect();
  }, [active, maxAnimatedHeight]);
  const immediate = reduced || oversized;
  const controls = useAnimationControls();
  useEffect(() => {
    const state = active === false ? "initial" : "visible";
    controls.stop();
    if (immediate) controls.set(state);
    else void controls.start(state);
  }, [active, immediate, preset, controls]);
  const duration = immediate
    ? 0
    : preset === "highlight"
      ? 0.9
      : ["dialog", "drawer", "panelContent"].includes(preset)
        ? 0.24
        : 0.18;
  return (
    <motion.div
      ref={element}
      className={className}
      layout={layout && !immediate ? "position" : false}
      variants={presets[preset]}
      initial={immediate || active !== undefined ? false : "initial"}
      animate={controls}
      exit="exit"
      transition={{ duration, ease }}
    >
      {children}
    </motion.div>
  );
}
export function LayoutGroup({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    // No layout projection here: measuring the whole result region on every
    // library update forced a full page layout per render.
    <AnimatedPanel className={className} preset="fadeIn">
      {children}
    </AnimatedPanel>
  );
}

export interface MotionTuning {
  stiffness: number;
  damping: number;
  pressScale: number;
  durationScale: number;
}
const TuningContext = createContext<MotionTuning>({
  stiffness: 520,
  damping: 38,
  pressScale: 0.98,
  durationScale: 1,
});
export function MotionTuningProvider({
  value,
  children,
}: {
  value: MotionTuning;
  children: ReactNode;
}) {
  return (
    <TuningContext.Provider value={value}>{children}</TuningContext.Provider>
  );
}
export function MotionScope({
  disabled,
  children,
}: {
  disabled: boolean;
  children: ReactNode;
}) {
  const current = useMotionPreference();
  return (
    <Context.Provider
      value={{ ...current, reduced: current.reduced || disabled }}
    >
      {children}
    </Context.Provider>
  );
}
/** Used only by the comparison lab; geometry changes remain immediate. */
export function ExperimentMotion({
  children,
  active = false,
  kind = "panel",
  className,
}: {
  children: ReactNode;
  active?: boolean;
  kind?: "press" | "panel" | "highlight" | "item";
  className?: string;
}) {
  const tuning = useContext(TuningContext),
    { reduced } = useMotionPreference();
  const target =
    kind === "press"
      ? { scale: active ? tuning.pressScale : 1 }
      : kind === "highlight"
        ? { backgroundColor: active ? "var(--mark)" : "var(--mark-soft)" }
        : { opacity: 1, x: 0 };
  return (
    <motion.div
      className={className}
      initial={kind === "panel" && !reduced ? { opacity: 0, x: 8 } : false}
      animate={target}
      exit={reduced ? {} : { opacity: 0, x: kind === "panel" ? 8 : 0 }}
      transition={
        reduced
          ? { duration: 0 }
          : kind === "press"
            ? {
                type: "spring",
                stiffness: tuning.stiffness,
                damping: tuning.damping,
              }
            : { duration: 0.18 * tuning.durationScale, ease }
      }
    >
      {children}
    </motion.div>
  );
}
