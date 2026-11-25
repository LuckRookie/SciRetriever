import type { IntakeBatchSummary } from "@sciretriever/contracts";
import {
  Badge,
  type BadgeStatus,
  type StatusTone,
} from "../../components/index.js";
import { batchStateText } from "../../data/imports.js";

/** A finished batch shows its result; the others their state. */
export function BatchBadge({ batch }: { batch: IntakeBatchSummary }) {
  const status: BadgeStatus =
    batch.state === "running"
      ? "running"
      : batch.state === "awaiting-confirmation"
        ? "pdf"
        : batch.state === "finished"
          ? batch.result === "completed"
            ? "completed"
            : batch.result === "failed"
              ? "failed"
              : "partial"
          : "metadata";
  return <Badge status={status}>{batchStateText(batch)}</Badge>;
}

/** Counts as “label n”, the zero ones left out unless asked to stay. */
export function Counts({
  items,
  keepZero = false,
  label,
}: {
  items: readonly (readonly [string, number])[];
  keepZero?: boolean;
  label?: string;
}) {
  const shown = items.filter(([, value]) => keepZero || value > 0);
  return (
    <span className="intake-counts" {...(label ? { "aria-label": label } : {})}>
      {shown.map(([name, value]) => (
        <span key={name}>
          {name} <b>{value.toLocaleString()}</b>
        </span>
      ))}
    </span>
  );
}

/**
 * A thin bar of parts out of a whole, each part named for screen readers and
 * drawn in its status's middle tone (design core rule 4).
 */
export function PartsBar({
  parts,
  total,
  label,
}: {
  parts: readonly { part: string; tone: StatusTone; value: number }[];
  total: number;
  label: string;
}) {
  const share = (n: number) => (total ? `${(n / total) * 100}%` : "0%");
  return (
    <div className="intake-bar" role="img" aria-label={label}>
      {parts.map(({ part, tone, value }) => (
        <i
          key={part}
          className="ui-tone-fill"
          data-part={part}
          data-tone={tone}
          style={{ width: share(value) }}
        />
      ))}
    </div>
  );
}
