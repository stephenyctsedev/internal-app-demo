// Barcode scanning dialog (user, 2026-11-19: 「喺打字search嗰個格嗰度加
// 多個掣開 Camera scan」— the barcode printed on the shelf price tag
// encodes the same number the search box already matches, so a scan just
// fills the search box and the existing filter does the rest).
//
// Live scan: native BarcodeDetector when the browser has it, otherwise
// ZXing (@zxing/browser, loaded lazily so it stays out of the main
// bundle). Photo fallback: pick or take a photo and decode it from the
// still image. Camera permission denial is surfaced with instructions —
// never a silent failure.

import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import type { Exception, Result } from "@zxing/library";

type ScanError =
  | { kind: "denied" }
  | { kind: "unavailable"; message: string }
  | { kind: "photo-none" }
  | { kind: "photo-failed"; message: string };

const SCAN_FORMATS = [
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "code_128",
  "code_39",
  "code_93",
  "codabar",
  "itf",
  "qr_code",
];

function describeCameraError(e: unknown): ScanError {
  if (e instanceof DOMException) {
    if (e.name === "NotAllowedError" || e.name === "SecurityError") {
      return { kind: "denied" };
    }
    if (e.name === "NotFoundError" || e.name === "OverconstrainedError") {
      return { kind: "unavailable", message: "搵唔到可用嘅相機。" };
    }
    if (e.name === "NotReadableError") {
      return { kind: "unavailable", message: "相機正俾其他程式使用緊，請關咗其他用到相機嘅程式再試。" };
    }
  }
  return {
    kind: "unavailable",
    message: "開唔到相機做即時掃描，可以改用下面影相／揀相嘅方法。",
  };
}

export function BarcodeScanner({
  onResult,
  onClose,
}: {
  onResult: (value: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const doneRef = useRef(false);
  const [error, setError] = useState<ScanError | null>(null);
  const [starting, setStarting] = useState(true);
  const [photoBusy, setPhotoBusy] = useState(false);

  const finish = useCallback(
    (value: string) => {
      if (doneRef.current) return;
      doneRef.current = true;
      onResult(value);
    },
    [onResult],
  );

  useEffect(() => {
    let cancelled = false;
    let raf = 0;

    const stopTracks = () => {
      controlsRef.current?.stop();
      controlsRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };

    const startZxing = async () => {
      const video = videoRef.current;
      if (!video) return;
      const reader = new BrowserMultiFormatReader();
      const controls = await reader.decodeFromConstraints(
        { video: { facingMode: "environment" }, audio: false },
        video,
        (result: Result | undefined, err: Exception | undefined) => {
          if (result) {
            finish(result.getText());
            return;
          }
          // ZXing reports permission denial through the callback error
          // before decodeFromConstraints itself rejects.
          if (err && err.name === "NotAllowedError") {
            stopTracks();
            setStarting(false);
            setError({ kind: "denied" });
          }
        },
      );
      if (cancelled) {
        controls.stop();
        return;
      }
      controlsRef.current = controls;
      setStarting(false);
    };

    const startNative = async (DetectorClass: typeof BarcodeDetector) => {
      const video = videoRef.current;
      if (!video) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      video.srcObject = stream;
      await video.play();
      const detector = new DetectorClass({ formats: SCAN_FORMATS });
      setStarting(false);
      const tick = async () => {
        if (cancelled || doneRef.current) return;
        try {
          const codes = await detector.detect(video);
          const hit = codes.find((c) => c.rawValue.trim().length > 0);
          if (hit) {
            finish(hit.rawValue.trim());
            return;
          }
        } catch {
          // A frame that cannot be processed (e.g. video not ready yet) —
          // just try the next one.
        }
        raf = requestAnimationFrame(() => void tick());
      };
      void tick();
    };

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStarting(false);
        setError({
          kind: "unavailable",
          message: "呢部裝置／瀏覽器唔支援即時相機掃描，可以改用下面影相／揀相嘅方法。",
        });
        return;
      }
      try {
        if (typeof window.BarcodeDetector === "function") {
          await startNative(window.BarcodeDetector);
        } else {
          await startZxing();
        }
      } catch (e) {
        if (cancelled) return;
        setStarting(false);
        setError(describeCameraError(e));
      }
    };

    void start();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stopTracks();
    };
  }, [finish]);

  const decodePhoto = async (file: File) => {
    setPhotoBusy(true);
    setError(null);
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      // Native detector first (handles ImageBitmapSource incl. HTMLImageElement).
      if (typeof window.BarcodeDetector === "function") {
        try {
          const detector = new window.BarcodeDetector({ formats: SCAN_FORMATS });
          const codes = await detector.detect(img);
          const hit = codes.find((c) => c.rawValue.trim().length > 0);
          if (hit) {
            finish(hit.rawValue.trim());
            return;
          }
        } catch {
          // Fall through to ZXing.
        }
      }
      const reader = new BrowserMultiFormatReader();
      const result = await reader.decodeFromImageElement(img);
      finish(result.getText());
    } catch (e) {
      if (e instanceof Error && /NotFound|No MultiFormat Readers/i.test(e.message + e.name)) {
        setError({ kind: "photo-none" });
      } else {
        setError({
          kind: "photo-failed",
          message: "讀唔到呢張相，試下影清楚啲、對正條碼再試。",
        });
      }
    } finally {
      URL.revokeObjectURL(url);
      setPhotoBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center"
      role="dialog"
      aria-label="掃描條碼"
    >
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-[var(--surface)] p-4 pb-6 text-[var(--text)] sm:rounded-2xl">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="min-w-0 truncate text-lg font-semibold">掃描條碼</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="關閉掃描"
            className="shrink-0 rounded-full bg-[var(--surface-alt)] px-3 py-1.5 text-sm"
          >
            ✕
          </button>
        </div>

        <div className="relative overflow-hidden rounded-[var(--radius)] bg-black">
          <video
            ref={videoRef}
            className="aspect-[4/3] w-full object-cover"
            autoPlay
            muted
            playsInline
            aria-label="相機畫面"
          />
          {starting && !error && (
            <p className="absolute inset-0 flex items-center justify-center text-sm text-white">
              正在開啟相機…
            </p>
          )}
          {!starting && !error && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-10 top-1/2 h-24 -translate-y-1/2 rounded-lg border-2 border-white/80"
            />
          )}
        </div>
        <p className="mt-2 text-center text-sm text-[var(--dim)]">
          將價錢牌或者貨品上嘅條碼對正框入面，掃到會自動搜尋。
        </p>

        {error?.kind === "denied" && (
          <p role="alert" className="mt-3 rounded-[var(--radius)] border border-[var(--bad)] px-3 py-2 text-sm text-[var(--bad)]">
            呢個頁面入面開唔到即時相機（相機權限被拒絕，或者喺 claude.ai 入面嘅頁面唔俾用相機）。請用下面「影相／揀相掃碼」，影低條碼一樣掃到。
          </p>
        )}
        {error?.kind === "unavailable" && (
          <p role="alert" className="mt-3 rounded-[var(--radius)] border border-[var(--bad)] px-3 py-2 text-sm text-[var(--bad)]">
            {error.message}
          </p>
        )}
        {error?.kind === "photo-none" && (
          <p role="alert" className="mt-3 rounded-[var(--radius)] border border-[var(--bad)] px-3 py-2 text-sm text-[var(--bad)]">
            呢張相入面搵唔到條碼，試下影清楚啲、對正條碼再試。
          </p>
        )}
        {error?.kind === "photo-failed" && (
          <p role="alert" className="mt-3 rounded-[var(--radius)] border border-[var(--bad)] px-3 py-2 text-sm text-[var(--bad)]">
            {error.message}
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={photoBusy}
            className="flex-1 rounded-[var(--radius)] border border-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-[var(--accent)] disabled:opacity-50"
          >
            {photoBusy ? "解碼緊…" : "影相／揀相掃碼"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius)] bg-[var(--surface-alt)] px-4 py-2.5 text-sm font-semibold"
          >
            取消
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          aria-label="影相或者揀相掃描條碼"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void decodePhoto(f);
          }}
        />
      </div>
    </div>
  );
}
