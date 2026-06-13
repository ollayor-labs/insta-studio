import React, { useCallback, useState } from "react";
import { Loader2, Upload, Image as ImageIcon, Clipboard } from "lucide-react";
import {
  showHeicConversionFailedToast,
  showImageDecodeFailedToast,
  showUnsupportedImageToast,
} from "@/lib/editorToasts";
import {
  IMAGE_INPUT_ACCEPT,
  ImageImportError,
  loadImportedImage,
} from "@/lib/imageImport";

interface DropZoneProps {
  onImageLoad: (img: HTMLImageElement, fileName: string, blob: Blob, mimeType: string) => void;
  onLoadingChange?: (loading: { name: string; size: number } | null) => void;
}

interface LoadingFile {
  name: string;
  size: number;
}

import { formatFileSize } from "@/lib/fileSize";

const DropZone: React.FC<DropZoneProps> = ({ onImageLoad, onLoadingChange }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [loadingFile, setLoadingFile] = useState<LoadingFile | null>(null);

  // Keep the parent in sync with the loading state. Used by the global
  // Cmd+V handler in `Index.tsx` to render a floating import indicator
  // even when the dropzone isn't visible (i.e. the editor is already
  // open and the user pastes a new image).
  React.useEffect(() => {
    onLoadingChange?.(loadingFile);
  }, [loadingFile, onLoadingChange]);

  const processFile = useCallback(async (file: File) => {
    const next: LoadingFile = { name: file.name, size: file.size };
    setLoadingFile(next);
    try {
      const { image, blob } = await loadImportedImage(file);
      const mimeType = blob.type || file.type || "image/jpeg";
      onImageLoad(image, file.name, blob, mimeType);
    } catch (error) {
      if (error instanceof ImageImportError) {
        if (error.code === "unsupported-format") {
          showUnsupportedImageToast();
          return;
        }

        if (error.code === "heic-conversion-failed") {
          showHeicConversionFailedToast();
          return;
        }

        if (error.code === "image-decode-failed") {
          showImageDecodeFailedToast();
          return;
        }
      }

      showImageDecodeFailedToast();
    } finally {
      setLoadingFile(null);
    }
  }, [onImageLoad]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      void processFile(file);
    }
  }, [processFile]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          void processFile(file);
        }
        break;
      }
    }
  }, [processFile]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      void processFile(file);
    }
    e.target.value = "";
  }, [processFile]);

  if (loadingFile) {
    return (
      <div className="filtr-dropzone" data-state="loading">
        <div className="flex flex-col items-center gap-5 p-8">
          <div className="relative">
            <div className="w-20 h-20 rounded-2xl bg-secondary flex items-center justify-center">
              <Loader2 className="w-9 h-9 text-primary animate-spin" />
            </div>
          </div>

          <div className="text-center space-y-1.5">
            <h2 className="font-display text-2xl text-foreground">Importing…</h2>
            <p className="text-foreground/90 font-mono-ui text-sm break-all max-w-md">
              {loadingFile.name}
            </p>
            <p className="text-muted-foreground font-mono-ui text-xs tracking-wide">
              {formatFileSize(loadingFile.size)}
            </p>
          </div>

          <p className="text-muted-foreground/60 font-mono-ui text-[11px] tracking-wide text-center max-w-sm">
            Large or HEIC files can take a few seconds. Hold tight.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`filtr-dropzone ${isDragging ? "active" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      onPaste={handlePaste}
      tabIndex={0}
    >
      <div className="flex flex-col items-center gap-6 p-8">
        <div className="relative">
          <div className="w-20 h-20 rounded-2xl bg-secondary flex items-center justify-center">
            <Upload className="w-8 h-8 text-primary" />
          </div>
          <div className="absolute -bottom-1 -right-1 w-7 h-7 rounded-lg bg-primary flex items-center justify-center">
            <ImageIcon className="w-4 h-4 text-primary-foreground" />
          </div>
        </div>

        <div className="text-center space-y-2">
          <h2 className="font-display text-2xl text-foreground">Drop your image here</h2>
          <p className="text-muted-foreground font-body text-sm">
            Drag & drop, paste from clipboard, or click to browse
          </p>
          <p className="text-muted-foreground/60 font-mono-ui text-xs tracking-wide">
            JPG · PNG · WEBP · HEIC · HEIF
          </p>
        </div>

        <label className="cursor-pointer">
          <span className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg bg-primary text-primary-foreground font-mono-ui text-sm tracking-wide hover:opacity-90 transition-opacity">
            <Clipboard className="w-4 h-4" />
            Browse Files
          </span>
          <input
            type="file"
            accept={IMAGE_INPUT_ACCEPT}
            className="hidden"
            onChange={handleFileInput}
          />
        </label>

        <div className="flex items-center gap-4 text-muted-foreground/40 font-mono-ui text-xs mt-2">
          <span className="flex items-center gap-1.5">
            <kbd className="px-1.5 py-0.5 rounded border border-border bg-secondary text-[10px]">⌘V</kbd>
            paste
          </span>
        </div>
      </div>
    </div>
  );
};

export default DropZone;
