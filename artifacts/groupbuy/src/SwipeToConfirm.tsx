import { useEffect, useLayoutEffect, useRef, useState } from "react";

const THUMB = 48; // px, same height the old button had (min-h-12)
const INSET = 4; // px gap between thumb and track edge
const THRESHOLD = 0.93; // how far (0..1) the thumb must travel to confirm

/**
 * "Slide to confirm" control that replaces a plain button, so a stray tap (or
 * a thumb brushing the card while scrolling) can't flip an order's pickup
 * state. `direction="right"` starts at the left edge and is dragged to the
 * right; `direction="left"` starts at the right edge and is dragged to the
 * left. Pointer events cover touch, pen and mouse; the thumb is also a
 * keyboard-operable slider (Enter / Space / the arrow key for its direction).
 */
export function SwipeToConfirm({
  label,
  ariaLabel,
  busy,
  tone,
  icon,
  direction,
  onConfirm,
}: {
  /** Hint text shown in the track, e.g. "向右掃，標記已領取". */
  label: string;
  /** Accessible name for the slider thumb. */
  ariaLabel: string;
  /** A write is in flight: shows 寫入緊… and ignores input (thumb doesn't move). */
  busy: boolean;
  /** "primary" = green call-to-action, "neutral" = undo. */
  tone: "primary" | "neutral";
  icon: string;
  direction: "right" | "left";
  onConfirm: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startTravel: number; id: number } | null>(null);
  const sawBusy = useRef(false);
  const [width, setWidth] = useState(0);
  // distance travelled from the start edge, 0..max (direction-independent)
  const [travel, setTravel] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [committed, setCommitted] = useState(false);
  // No transitions on the very first paint, so a freshly mounted slider appears
  // at its start edge instead of sliding there from the left.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const max = Math.max(0, width - THUMB - INSET * 2);
  const sign = direction === "right" ? 1 : -1;

  // Normally the card flips (optimistically) as soon as the slide is confirmed,
  // which remounts this component for the opposite state. If the write fails
  // and nothing flips, spring back so the user can try again.
  useEffect(() => {
    if (busy) {
      sawBusy.current = true;
      return;
    }
    if (!(sawBusy.current && committed)) return;
    const id = setTimeout(() => {
      sawBusy.current = false;
      setCommitted(false);
      setTravel(0);
    }, 1500);
    return () => clearTimeout(id);
  }, [busy, committed]);

  const confirm = () => {
    setCommitted(true);
    setTravel(max);
    onConfirm();
  };

  const locked = busy || committed;
  // Don't move the thumb while a write is in flight: it stays wherever the
  // user released it, which is exactly where the opposite-state slider starts.
  const t = Math.min(travel, max);
  const progress = max > 0 ? Math.min(1, t / max) : 0;
  // thumb's offset from the left inset: 0 at left edge, `max` at right edge
  const offset = direction === "right" ? t : max - t;

  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (locked) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startTravel: t, id: e.pointerId };
    setDragging(true);
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    setTravel(Math.min(max, Math.max(0, d.startTravel + sign * (e.clientX - d.startX))));
  };
  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (e.type !== "pointercancel" && max > 0 && travel >= max * THRESHOLD) confirm();
    else setTravel(0);
  };
  const confirmKey = direction === "right" ? "ArrowRight" : "ArrowLeft";
  const key = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (locked) return;
    if (e.key === "Enter" || e.key === " " || e.key === confirmKey) {
      e.preventDefault();
      confirm();
    }
  };

  const primary = tone === "primary";
  const toRight = direction === "right";
  return (
    <div
      ref={trackRef}
      className={`relative mt-3 h-14 select-none overflow-hidden rounded-2xl border ${
        primary
          ? "border-(--accent) bg-(--accent)/10"
          : "border-(--border) bg-(--bg)"
      } ${busy ? "opacity-60" : ""}`}
    >
      {/* progress fill that trails the thumb */}
      <div
        aria-hidden
        className={`absolute inset-y-0 rounded-2xl ${toRight ? "left-0" : "right-0"} ${
          primary ? "bg-(--accent)/25" : "bg-(--border)"
        }`}
        style={{
          width: t + THUMB + INSET * 2,
          transition: dragging || !armed ? "none" : "width 0.2s ease-out",
        }}
      />
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-0 flex items-center justify-center text-base font-bold ${
          toRight ? "pl-12" : "pr-12"
        } ${primary ? "text-(--accent)" : "text-(--dim)"}`}
        style={{ opacity: busy ? 1 : 1 - progress * 1.4 }}
      >
        {busy ? "寫入緊…" : toRight ? `${label}  ›››` : `‹‹‹  ${label}`}
      </span>
      <div
        role="slider"
        tabIndex={locked ? -1 : 0}
        aria-label={ariaLabel}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        aria-disabled={locked}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
        className={`absolute flex items-center justify-center rounded-xl text-xl font-bold text-white outline-offset-2 focus-visible:outline-2 focus-visible:outline-(--accent) ${
          primary ? "bg-(--accent)" : "bg-(--dim)"
        } ${locked ? "cursor-default" : "cursor-grab active:cursor-grabbing"}`}
        style={{
          top: INSET,
          left: INSET,
          width: THUMB,
          height: THUMB,
          transform: `translateX(${offset}px)`,
          transition: dragging || !armed ? "none" : "transform 0.2s ease-out",
          touchAction: "none",
        }}
      >
        {icon}
      </div>
    </div>
  );
}
