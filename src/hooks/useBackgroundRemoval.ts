import { useCallback, useEffect, useRef, useState } from "react";

export interface BgRemovalResult {
  mask: Uint8Array;
  width: number;
  height: number;
}

export type BgRemovalPhase = "init" | "download" | "inference";

export interface UseBackgroundRemoval {
  removeBackground: (
    source: HTMLImageElement | ImageBitmap,
  ) => Promise<BgRemovalResult>;
  /**
   * Pre-warm the worker and start the model download without running
   * inference. Safe to call multiple times — no-ops once loading has begun.
   * Call this on Cutout-tab open so the ~44MB download starts as soon as the
   * user shows intent, hiding the silent worker-script + WASM fetches behind
   * their exploration of the panel.
   */
  warmup: () => void;
  /** 0..100 model download percentage (download phase only). */
  progress: number;
  /** Which phase is active — drives the spinner-vs-bar choice in the UI. */
  phase: BgRemovalPhase | null;
  /** Backend the model loaded on; surfaced so the UI can hint CPU mode. */
  device: "webgpu" | "wasm" | null;
  /** Bytes downloaded so far in the current download phase (if reported). */
  loaded: number | null;
  /** Total bytes for the current download phase (if reported). */
  total: number | null;
  status: "idle" | "loading" | "running" | "ready" | "error";
  error: string | null;
}

type WorkerOut =
  | {
      type: "progress";
      phase: BgRemovalPhase;
      value?: number;
      loaded?: number;
      total?: number;
      file?: string;
    }
  | { type: "ready"; device: "webgpu" | "wasm" }
  | { type: "result"; mask: ArrayBuffer; width: number; height: number }
  | { type: "error"; message: string };

/**
 * React hook wrapping the on-device background-removal worker.
 *
 * The worker (and thus the ~44MB model download) is created lazily — either
 * on the first `removeBackground` call, or earlier via `warmup()` (e.g. when
 * the user opens the Cutout tab). The worker is reused across calls and
 * terminated on unmount.
 */
export function useBackgroundRemoval(): UseBackgroundRemoval {
  const workerRef = useRef<Worker | null>(null);
  // Only one run at a time; the pending promise callbacks live here.
  const pendingRef = useRef<{
    resolve: (r: BgRemovalResult) => void;
    reject: (e: Error) => void;
  } | null>(null);

  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<BgRemovalPhase | null>(null);
  const [device, setDevice] = useState<"webgpu" | "wasm" | null>(null);
  const [loaded, setLoaded] = useState<number | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [status, setStatus] = useState<UseBackgroundRemoval["status"]>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
      pendingRef.current = null;
    };
  }, []);

  const getWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current;

    const worker = new Worker(
      new URL("../workers/bgRemoval.worker.ts", import.meta.url),
      { type: "module" },
    );

    worker.onmessage = (event: MessageEvent<WorkerOut>) => {
      const msg = event.data;
      switch (msg.type) {
        case "progress":
          setPhase(msg.phase);
          if (typeof msg.value === "number") {
            setProgress(Math.max(0, Math.min(100, msg.value)));
          }
          setLoaded(typeof msg.loaded === "number" ? msg.loaded : null);
          setTotal(typeof msg.total === "number" ? msg.total : null);
          break;
        case "ready":
          setDevice(msg.device);
          // First-run fix: if a run is pending (the user clicked "Remove
          // background" while the model was still downloading), the model
          // has just finished warming and inference is about to start —
          // transition to "running" so the UI shows the Processing state
          // instead of reverting to an idle-looking ready.
          setStatus((s) =>
            pendingRef.current ? "running" : s === "loading" ? "ready" : s,
          );
          break;
        case "result": {
          const pending = pendingRef.current;
          pendingRef.current = null;
          setPhase(null);
          setStatus("ready");
          if (pending) {
            pending.resolve({
              mask: new Uint8Array(msg.mask),
              width: msg.width,
              height: msg.height,
            });
          }
          break;
        }
        case "error": {
          const pending = pendingRef.current;
          pendingRef.current = null;
          setStatus("error");
          setError(msg.message);
          if (pending) pending.reject(new Error(msg.message));
          break;
        }
      }
    };

    worker.onerror = (event) => {
      const message = event.message || "Background removal worker crashed.";
      const pending = pendingRef.current;
      pendingRef.current = null;
      setStatus("error");
      setError(message);
      if (pending) pending.reject(new Error(message));
    };

    workerRef.current = worker;
    return worker;
  }, []);

  const warmup = useCallback((): void => {
    const worker = getWorker();
    setError(null);
    setStatus((s) => (s === "idle" ? "loading" : s));
    worker.postMessage({ type: "init" });
  }, [getWorker]);

  const removeBackground = useCallback(
    async (source: HTMLImageElement | ImageBitmap): Promise<BgRemovalResult> => {
      if (pendingRef.current) {
        throw new Error("A background removal is already in progress.");
      }

      const worker = getWorker();
      setError(null);
      // First real load vs. subsequent runs: if the model isn't warm yet the
      // "loading" state drives the download progress bar.
      setStatus((s) => (s === "ready" ? "running" : "loading"));

      // Build an ImageBitmap we can transfer into the worker.
      const bitmap =
        source instanceof ImageBitmap ? source : await createImageBitmap(source);

      return new Promise<BgRemovalResult>((resolve, reject) => {
        pendingRef.current = { resolve, reject };
        setStatus((s) => (s === "loading" ? "loading" : "running"));
        try {
          worker.postMessage({ type: "run", bitmap }, [bitmap]);
        } catch (err) {
          pendingRef.current = null;
          const message = err instanceof Error ? err.message : String(err);
          setStatus("error");
          setError(message);
          reject(new Error(message));
        }
      });
    },
    [getWorker],
  );

  return {
    removeBackground,
    warmup,
    progress,
    phase,
    device,
    loaded,
    total,
    status,
    error,
  };
}
