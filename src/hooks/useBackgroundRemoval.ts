import { useCallback, useEffect, useRef, useState } from "react";

export interface BgRemovalResult {
  mask: Uint8Array;
  width: number;
  height: number;
}

export interface UseBackgroundRemoval {
  removeBackground: (
    source: HTMLImageElement | ImageBitmap,
  ) => Promise<BgRemovalResult>;
  progress: number; // 0..100 model download
  status: "idle" | "loading" | "running" | "ready" | "error";
  error: string | null;
}

type WorkerOut =
  | { type: "progress"; value: number }
  | { type: "ready" }
  | { type: "result"; mask: ArrayBuffer; width: number; height: number }
  | { type: "error"; message: string };

/**
 * React hook wrapping the on-device background-removal worker.
 *
 * The worker (and thus the ~44MB model download) is created lazily on the
 * first `removeBackground` call, so nothing loads until the user opts in.
 * The worker is reused across calls and terminated on unmount.
 */
export function useBackgroundRemoval(): UseBackgroundRemoval {
  const workerRef = useRef<Worker | null>(null);
  // Only one run at a time; the pending promise callbacks live here.
  const pendingRef = useRef<{
    resolve: (r: BgRemovalResult) => void;
    reject: (e: Error) => void;
  } | null>(null);

  const [progress, setProgress] = useState(0);
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
          setProgress(msg.value);
          break;
        case "ready":
          setStatus((s) => (s === "loading" ? "ready" : s));
          break;
        case "result": {
          const pending = pendingRef.current;
          pendingRef.current = null;
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

  return { removeBackground, progress, status, error };
}
