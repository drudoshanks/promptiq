import { diffWords, originalSide, proposedSide, type DiffSegment } from "@/lib/diff";
import { cx } from "@/lib/utils";

function Segments({ segments, side }: { segments: DiffSegment[]; side: "original" | "proposed" }) {
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type === "equal" || !segment.text.trim()) {
          return <span key={index}>{segment.text}</span>;
        }
        const isAdded = segment.type === "added";
        return (
          <mark key={index} className={cx(isAdded ? "diff-added" : "diff-removed")} aria-label={isAdded ? "added" : "removed"} data-side={side}>
            {segment.text}
          </mark>
        );
      })}
    </>
  );
}

interface DiffViewProps {
  original: string;
  proposed: string;
  /** Render change marks (off while the user is editing the proposed text). */
  highlight?: boolean;
  className?: string;
}

/**
 * The comparison itself (FR-006, §11): original and proposed side by side with
 * word-level change marks. Works without JavaScript — it is a server-renderable
 * pure component.
 */
export function DiffView({ original, proposed, highlight = true, className }: DiffViewProps) {
  const segments = highlight ? diffWords(original, proposed) : null;
  return (
    <div className={cx("grid gap-4 lg:grid-cols-2", className)}>
      <section aria-labelledby="diff-original" className="panel-soft p-4">
        <h3 id="diff-original" className="mb-3 text-sm font-medium text-ink-soft">
          Original
        </h3>
        <div className="prompt-text">{segments ? <Segments segments={originalSide(segments)} side="original" /> : original}</div>
      </section>
      <section aria-labelledby="diff-proposed" className="panel p-4">
        <h3 id="diff-proposed" className="mb-3 text-sm font-medium text-ink-soft">
          Proposed
        </h3>
        <div className="prompt-text">{segments ? <Segments segments={proposedSide(segments)} side="proposed" /> : proposed}</div>
      </section>
    </div>
  );
}
