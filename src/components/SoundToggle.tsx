import { Volume2, VolumeX } from "lucide-react";
import { useSound } from "@/lib/sound/sound-provider";

/**
 * Header control that mutes/unmutes cuelume interaction sounds.
 * Reflects the persisted `filtr.sound` preference (off when the
 * system requests reduced motion).
 */
export function SoundToggle() {
  const { enabled, setEnabled } = useSound();

  return (
    <button
      type="button"
      onClick={() => setEnabled(!enabled)}
      title={enabled ? "Mute interface sounds" : "Enable interface sounds"}
      aria-pressed={enabled}
      data-cuelume-press
      data-cuelume-release
      className="flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
    >
      {enabled ? (
        <Volume2 className="h-4 w-4" />
      ) : (
        <VolumeX className="h-4 w-4" />
      )}
    </button>
  );
}
