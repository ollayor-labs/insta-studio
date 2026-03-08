import React, { useCallback, useState } from "react";
import { Upload, Image as ImageIcon, Clipboard } from "lucide-react";

interface DropZoneProps {
  onImageLoad: (img: HTMLImageElement, fileName: string) => void;
}

const DropZone: React.FC<DropZoneProps> = ({ onImageLoad }) => {
  const [isDragging, setIsDragging] = useState(false);

  const processFile = useCallback((file: File) => {
    if (!file.type.match(/^image\/(jpeg|png|webp)$/)) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => onImageLoad(img, file.name);
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  }, [onImageLoad]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, [processFile]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) processFile(file);
        break;
      }
    }
  }, [processFile]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  }, [processFile]);

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
            JPG · PNG · WEBP
          </p>
        </div>

        <label className="cursor-pointer">
          <span className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg bg-primary text-primary-foreground font-mono-ui text-sm tracking-wide hover:opacity-90 transition-opacity">
            <Clipboard className="w-4 h-4" />
            Browse Files
          </span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
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
