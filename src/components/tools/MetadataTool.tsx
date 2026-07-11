import React, { useEffect, useState } from "react";
import {
  Aperture,
  Camera,
  Copyright,
  ImageIcon,
  Loader2,
  MapPin,
  ShieldCheck,
} from "lucide-react";
import {
  formatCamera,
  formatExposure,
  formatFNumber,
  formatFocalLength,
  readImageMetadata,
  type ImageMeta,
  type MetadataPrivacy,
} from "@/lib/metadata";

export interface MetadataToolProps {
  file: File | Blob | null;
  privacy: MetadataPrivacy;
  onPrivacyChange: (p: MetadataPrivacy) => void;
}

const EM_DASH = "—";

const PRIVACY_OPTIONS: Array<{
  value: MetadataPrivacy;
  label: string;
  caption: string;
}> = [
  { value: "keep", label: "Keep", caption: "Exported file keeps all camera and location data." },
  {
    value: "strip-gps",
    label: "Strip location",
    caption: "Removes GPS coordinates. Camera data stays in the exported file.",
  },
  {
    value: "strip-all",
    label: "Strip all",
    caption: "Removes every metadata tag from the exported file.",
  },
];

function FieldRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="font-mono-ui text-[11px] text-muted-foreground">{label}</span>
      <span className="font-mono-ui text-[11px] text-secondary-foreground tabular-nums text-right">
        {value}
      </span>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 px-1 font-mono-ui text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
        <Icon className="h-3 w-3 text-primary" />
        {title}
      </p>
      <div className="space-y-1.5 rounded-xl border border-border bg-card/50 px-3 py-3">
        {children}
      </div>
    </div>
  );
}

const MetadataTool: React.FC<MetadataToolProps> = ({ file, privacy, onPrivacyChange }) => {
  const [meta, setMeta] = useState<ImageMeta | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!file) {
      setMeta(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setMeta(null);
    readImageMetadata(file)
      .then((result) => {
        if (cancelled) return;
        setMeta(result);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  return (
    <div className="h-full w-full space-y-4 overflow-y-auto p-3">
      <div className="space-y-1 px-1">
        <h2 className="font-display text-lg text-foreground">Metadata</h2>
        <p className="font-mono-ui text-[10px] uppercase tracking-[0.16em] text-primary">
          EXIF &amp; Privacy
        </p>
      </div>

      {!file ? (
        <p className="px-1 font-mono-ui text-[12px] leading-relaxed text-muted-foreground">
          Load an image to inspect metadata.
        </p>
      ) : loading ? (
        <p className="flex items-center gap-2 px-1 font-mono-ui text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          Reading…
        </p>
      ) : !meta ? (
        <p className="px-1 font-mono-ui text-[12px] leading-relaxed text-muted-foreground">
          No embedded metadata found in this image.
        </p>
      ) : (
        <div className="space-y-4">
          <Section icon={Camera} title="Camera">
            <FieldRow label="Body" value={formatCamera(meta.make, meta.model)} />
            <FieldRow label="Lens" value={meta.lens ?? EM_DASH} />
            <FieldRow label="Captured" value={meta.dateTime ?? EM_DASH} />
          </Section>

          <Section icon={Aperture} title="Exposure">
            <FieldRow label="ISO" value={meta.iso != null ? meta.iso : EM_DASH} />
            <FieldRow label="Aperture" value={formatFNumber(meta.fNumber)} />
            <FieldRow label="Shutter" value={formatExposure(meta.exposureTime)} />
            <FieldRow label="Focal length" value={formatFocalLength(meta.focalLength)} />
          </Section>

          <Section icon={ImageIcon} title="Dimensions">
            <FieldRow
              label="Size"
              value={
                meta.width != null && meta.height != null
                  ? `${meta.width} × ${meta.height}`
                  : EM_DASH
              }
            />
          </Section>

          <Section icon={MapPin} title="Location">
            {meta.hasGps ? (
              <>
                <FieldRow
                  label="Latitude"
                  value={meta.lat != null ? meta.lat.toFixed(4) : EM_DASH}
                />
                <FieldRow
                  label="Longitude"
                  value={meta.lon != null ? meta.lon.toFixed(4) : EM_DASH}
                />
                <span className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 font-mono-ui text-[9px] uppercase tracking-[0.12em] text-primary">
                  <MapPin className="h-2.5 w-2.5" />
                  Location is embedded
                </span>
              </>
            ) : (
              <p className="font-mono-ui text-[11px] text-muted-foreground">No location data</p>
            )}
          </Section>

          <Section icon={Copyright} title="Authorship">
            <FieldRow label="Artist" value={meta.artist ?? EM_DASH} />
            <FieldRow label="Copyright" value={meta.copyright ?? EM_DASH} />
          </Section>
        </div>
      )}

      <div className="space-y-2">
        <p className="flex items-center gap-1.5 px-1 font-mono-ui text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
          <ShieldCheck className="h-3 w-3 text-primary" />
          Privacy
        </p>
        <div className="rounded-xl border border-border bg-card/50 p-3 space-y-3">
          <div
            role="radiogroup"
            aria-label="Metadata privacy policy"
            className="flex items-center rounded-lg border border-border bg-card/50 p-0.5 font-mono-ui text-[10px] uppercase tracking-[0.12em]"
          >
            {PRIVACY_OPTIONS.map((option) => {
              const active = privacy === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onPrivacyChange(option.value)}
                  className={`flex-1 rounded-md px-2 py-1.5 transition-colors ${
                    active
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <p className="px-1 font-mono-ui text-[10px] leading-relaxed text-muted-foreground">
            {PRIVACY_OPTIONS.find((option) => option.value === privacy)?.caption}
          </p>
        </div>
      </div>
    </div>
  );
};

export default MetadataTool;
