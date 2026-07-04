import React from "react";
import { toast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";

function showMinimalToast(title: string, description?: string) {
  toast({
    title,
    description,
  });
}

export function showFilterChangedToast(filterName: string, strength: number) {
  showMinimalToast(filterName, `Preset applied at ${strength}% strength`);
}

export function showCopyToast() {
  showMinimalToast("Copied", "Edited image copied to clipboard");
}

export function showDownloadToast(filterName: string) {
  showMinimalToast("Download started", `${filterName} export is downloading`);
}

export function showCopyFailedToast() {
  toast({
    variant: "destructive",
    title: "Copy failed",
    description: "Clipboard access was blocked for this image.",
  });
}

export function showUnsupportedImageToast() {
  toast({
    variant: "destructive",
    title: "Unsupported image",
    description: "Use JPG, PNG, WEBP, HEIC, or HEIF.",
  });
}

export function showHeicConversionFailedToast() {
  toast({
    variant: "destructive",
    title: "HEIC conversion failed",
    description: "This HEIC image could not be converted in the browser.",
  });
}

export function showImageDecodeFailedToast() {
  toast({
    variant: "destructive",
    title: "Image load failed",
    description: "The selected image could not be decoded.",
  });
}

export function showUndoToast(label: string | null) {
  toast({
    title: "Undone",
    description: label ?? undefined,
    duration: 1500,
  });
}

export function showRedoToast(label: string | null) {
  toast({
    title: "Redone",
    description: label ?? undefined,
    duration: 1500,
  });
}

export function showCropAppliedToast(ratioLabel: string) {
  showMinimalToast("Crop applied", ratioLabel);
}

export function showCropResetToast() {
  showMinimalToast("Crop reset", "Full image restored");
}

/**
 * Show the post-export "receipt" toast. The receipt is the
 * auto-derived string from `buildExportReceipt` and acts as
 * evidence to the user that the profile was actually applied.
 *
 * When `onViewHistory` is provided we render a "View" action
 * that closes the toast and triggers the supplied callback —
 * the page uses that to open the Recent Exports popover.
 */
export function showExportReceiptToast(
  filterName: string,
  receipt: string,
  fileName: string,
  onViewHistory?: () => void,
) {
  toast({
    title: `Exported · ${filterName}`,
    description: (
      <div className="flex flex-col gap-0.5">
        <span className="text-foreground/90">{receipt}</span>
        <span className="font-mono-ui text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          {fileName}
        </span>
      </div>
    ),
    duration: 6000,
    action: onViewHistory ? (
      <ToastAction altText="View recent exports" onClick={onViewHistory}>
        View
      </ToastAction>
    ) : undefined,
  });
}

export function showExportProfileChangedToast(profileLabel: string) {
  showMinimalToast("Export profile", profileLabel);
}
