import { toast } from "@/hooks/use-toast";

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
