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
