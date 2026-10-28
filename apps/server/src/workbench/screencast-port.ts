import type {
  ScreencastControlState,
  ScreencastStatus,
  ScreencastPageKind,
} from "@sciretriever/contracts";
import type { PageScreencastFrame } from "../browser/screencast.js";

/** Process-local port. No credentials, image bytes or input text enter the durable view. */
export interface WorkbenchScreencastState {
  readonly status: ScreencastStatus;
  readonly stream_epoch: number;
  readonly page_kind?: ScreencastPageKind;
  readonly control: ScreencastControlState;
  readonly control_epoch: number;
  readonly agent_paused: boolean;
  readonly code?: string;
}
export interface WorkbenchScreencastObserver {
  frame(frame: PageScreencastFrame): void;
  state(state: WorkbenchScreencastState): void;
}
