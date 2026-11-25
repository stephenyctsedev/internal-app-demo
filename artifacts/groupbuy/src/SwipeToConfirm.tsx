import { useEffect, useRef, useState } from "react";

const THUMB = 48; // px, same height the old button had (min-h-12)
const INSET = 4; // px gap between thumb and track edge
const THRESHOLD = 0.93; // how far (0..1) the thumb must travel to confirm

/**
 * Left-to-right "slide to confirm" control that replaces a plain button, so a
 * stray tap (or a thumb brushing the card while scrolling) can't flip an
 * order's pickup state. Pointer events cover touch, pen and mouse; the thumb
 * is also a keyboard-operable slider (Enter / Space / → confirm).
 */
export function SwipeToConfirm({
  label,
  ariaLabel,
  busy,
  tone,
  icon,
  onConfirm,
}: {
  /** Hint text shown in the track, e.g. "向右掃，標記已領取". */
  label: string;
  /** Accessible name for the slider thumb. */
  ariaLabel: string;
  /** A write is in flight: thumb parks at the end and ignores input. */
  busy: boolean;
  /** "primary" = green call-to-action, "neutral" = undo. */
  tone: "primary" | "neutral";
  icon: string;
  onConfirm: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startPos: number; id: number } | null>(null);
  const sawBusy = useRef(false);
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [committed, setCommitted] = useState(false);

  const maxX = () => Math.max(0, (trackRef.current?.clientWidth ?? 0) - THUMB - INSET * 2);

  // After a write finishes without the card flipping (i.e. it failed), spring
  // back to the start so the user can try again.
  useEffect(() => {
    if (busy) {
      sawBusy.current = true;
    } else if (sawBusy.current && committed) {
      sawBusy.current = false;
      setCommitted(false);
      setX(0);
    }
  }, [busy, committed]);

  const confirm = () => {
    setCommitted(true);
    setX(maxX());
    onConfirm();
  };

  const locked = busy || committed;
  const pos = busy ? maxX() : x;
  const max = maxX();
  const progress = max > 0 ? Math.min(1, pos / max) : 0;

  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (locked) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startPos: x, id: e.pointerId };
    setDragging(true);
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    setX(Math.min(maxX(), Math.max(0, d.startPos + e.clientX - d.startX)));
  };
  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (e.type !== "pointercancel" && maxX() > 0 && x >= maxX() * THRESHOLD) confirm();
    else setX(0);
  };
  const key = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (locked) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowRight") {
      e.preventDefault();
      confirm();
    }
  };

  const primary = tone === "primary";
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
        className={`absolute inset-y-0 left-0 rounded-2xl ${primary ? "bg-(--accent)/25" : "bg-(--border)"}`}
        style={{
          width: pos + THUMB + INSET * 2,
          transition: dragging ? "none" : "width 0.2s ease-out",
        }}
      />
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-0 flex items-center justify-center pl-12 text-base font-bold ${
          primary ? "text-(--accent)" : "text-(--dim)"
        }`}
        style={{ opacity: busy ? 1 : 1 - progress * 1.4 }}
      >
        {busy ? "寫入緊…" : `${label}  ›››`}
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
          transform: `translateX(${pos}px)`,
          transition: dragging ? "none" : "transform 0.2s ease-out",
          touchAction: "none",
        }}
      >
        {icon}
      </div>
    </div>
  );
}
