import { useEffect, useId, useRef, useState } from "react";
import type { SiteLocation } from "../types";
import { Button, Input } from "../components/ui";
import {
  googleEarthUrl,
  type BoundaryMetrics,
} from "../lib/geo";
import { createSiteReference, siteLocationValue, siteMeasuresInUnit, siteReferenceFields, type SiteMeasureFields } from "../lib/siteLocation";

export type LocatorMode = "area" | "route";

interface SiteLocatorProps {
  location?: SiteLocation;
  mode?: LocatorMode;
  onChange: (location: SiteLocation | undefined, metrics?: BoundaryMetrics) => void;
  /** Notification after the single location/extent commit; avoid a second parent state replacement. */
  onApplyBoundary?: (metrics: BoundaryMetrics) => void;
}

export function SiteLocator({ location, mode = "area", onChange, onApplyBoundary }: SiteLocatorProps) {
  const polygonInputId = useId(), earthGuideId = useId();
  const [initialForm] = useState(() => siteReferenceFields(location));
  const [lat, setLat] = useState(initialForm.latitude);
  const [lng, setLng] = useState(initialForm.longitude);
  const [landShape, setLandShape] = useState(initialForm.shape);
  const [{ width: measuredWidth, depth: measuredLength, unit }, setMeasures] = useState<SiteMeasureFields>({ width: initialForm.width, depth: initialForm.depth, unit: "m" });
  const [polygonCoordsText, setPolygonCoordsText] = useState(initialForm.polygon);
  const [rotationDeg, setRotationDeg] = useState(initialForm.rotation);
  const [showEarthGuide, setShowEarthGuide] = useState(false);
  const [createdFeedback, setCreatedFeedback] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const pendingLocationValue = useRef<string | null>(null);
  const locationValue = siteLocationValue(location);

  useEffect(() => {
    const changedLocation = (JSON.parse(locationValue) ?? undefined) as SiteLocation | undefined;
    const fields = siteReferenceFields(changedLocation);
    setLat(fields.latitude);
    setLng(fields.longitude);
    setLandShape(fields.shape);
    setPolygonCoordsText(fields.polygon);
    setRotationDeg(fields.rotation);
    setMeasures((current) => {
      const converted = siteReferenceFields(changedLocation, current.unit);
      return { width: converted.width, depth: converted.depth, unit: current.unit };
    });
    if (locationValue !== pendingLocationValue.current) {
      setInputError(null);
      setCreatedFeedback(null);
    }
    pendingLocationValue.current = null;
  }, [locationValue]);

  const currentLat = Number(lat), currentLng = Number(lng);
  const earthUrl = lat.trim() && lng.trim() && Number.isFinite(currentLat) && Number.isFinite(currentLng) && Math.abs(currentLat) <= 90 && Math.abs(currentLng) <= 180
    ? googleEarthUrl(currentLat, currentLng) : undefined;

  const handleCreateCanvas = () => {
    setCreatedFeedback(null);
    try {
      const { location: updatedLocation, metrics } = createSiteReference({
        latitude: lat, longitude: lng, width: measuredWidth, depth: measuredLength,
        rotation: rotationDeg, unit, shape: landShape, polygon: polygonCoordsText, mode,
      });
      // Keep the coordinate reference and measured extent in one parent commit.
      pendingLocationValue.current = siteLocationValue(updatedLocation);
      onChange(updatedLocation, metrics);
      onApplyBoundary?.(metrics);
      setLat(String(updatedLocation.lat));
      setLng(String(updatedLocation.lng));
      setInputError(null);
      setCreatedFeedback("Coordinate reference set with a " + metrics.widthM.toFixed(1) + " m × " + metrics.depthM.toFixed(1) + " m canvas. Map imagery is not loaded.");
    } catch (error) {
      pendingLocationValue.current = null;
      setInputError(error instanceof Error ? error.message : "Check the entered site coordinates and dimensions.");
    }
  };

  return (
    <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-slate-100">
      {/* Header with Google Earth View Link */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
              🌍
            </span>
            Site coordinates & measured canvas
          </h3>
          <p className="text-xs text-slate-400">
            Enter coordinates and measured dimensions or boundary corners. The scene uses a local coordinate reference; map imagery is not loaded.
          </p>
        </div>

        <a
          href={earthUrl}
          aria-disabled={!earthUrl}
          title={earthUrl ? "Opens Google with the entered coordinates" : "Enter valid latitude and longitude first"}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-500/20 shadow-sm"
        >
          <span>Open Google Earth</span>
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      </div>

      {/* Google Earth Measurement Guide Toggle */}
      <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
        <button
          type="button"
          onClick={() => setShowEarthGuide(!showEarthGuide)}
          aria-expanded={showEarthGuide}
          aria-controls={earthGuideId}
          className="flex w-full items-center justify-between text-left text-xs font-medium text-slate-300 hover:text-emerald-300"
        >
          <span>📏 How to measure land in Google Earth</span>
          <span className="text-emerald-400 text-xs">{showEarthGuide ? "Hide guidance ▲" : "Show steps ▼"}</span>
        </button>
        {showEarthGuide && (
          <ol id={earthGuideId} className="mt-2.5 list-decimal space-y-1 pl-4 text-xs leading-relaxed text-slate-400">
            <li>Use <strong>"Open Google Earth"</strong> to view the entered location in an external service.</li>
            <li>In Google Earth, click the <strong>Ruler / Measure</strong> icon (on the left panel).</li>
            <li>Click points around your property or plot boundary to measure perimeter, length & breadth, or area.</li>
            <li>Enter measured dimensions or boundary corner coordinates below, then create the local canvas. Confirm survey dimensions independently.</li>
          </ol>
        )}
      </div>

      {/* Coordinates */}
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Site Latitude"
          value={lat}
          onChange={(e) => setLat(e.target.value)}
          placeholder="12.9716"
        />
        <Input
          label="Site Longitude"
          value={lng}
          onChange={(e) => setLng(e.target.value)}
          placeholder="77.5946"
        />
      </div>

      {/* Shape & Measurement Options */}
      <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-300">Measured Land Shape</span>
          <div className="flex rounded-lg border border-slate-800 bg-slate-900 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setMeasures((current) => siteMeasuresInUnit(current, "m"))}
              aria-pressed={unit === "m"}
              className={`rounded px-2.5 py-0.5 font-medium transition ${unit === "m" ? "bg-emerald-500/20 text-emerald-300" : "text-slate-400"}`}
            >
              Meters
            </button>
            <button
              type="button"
              onClick={() => setMeasures((current) => siteMeasuresInUnit(current, "ft"))}
              aria-pressed={unit === "ft"}
              className={`rounded px-2.5 py-0.5 font-medium transition ${unit === "ft" ? "bg-emerald-500/20 text-emerald-300" : "text-slate-400"}`}
            >
              Feet
            </button>
          </div>
        </div>

        <div className="flex gap-2">
          {(["rectangle", "polygon", "corridor"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setLandShape(s)}
              aria-pressed={landShape === s}
              className={`flex-1 rounded-lg border py-1.5 text-xs font-medium capitalize transition ${
                landShape === s
                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-300"
                  : "border-slate-800 bg-slate-900/60 text-slate-400 hover:border-slate-700"
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label={`Breadth / Width (${unit})`}
            disabled={landShape === "polygon"}
            value={measuredWidth}
            onChange={(e) => setMeasures((current) => ({ ...current, width: e.target.value }))}
            placeholder={unit === "m" ? "80" : "260"}
          />
          <Input
            label={`Length / Depth (${unit})`}
            disabled={landShape === "polygon"}
            value={measuredLength}
            onChange={(e) => setMeasures((current) => ({ ...current, depth: e.target.value }))}
            placeholder={unit === "m" ? "60" : "200"}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Width-axis angle from east (°)"
            disabled={landShape === "polygon"}
            value={rotationDeg}
            onChange={(e) => setRotationDeg(e.target.value)}
            placeholder="0"
          />
          <div className="flex flex-col justify-end">
            <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-2 text-xs text-slate-400">
              {landShape === "polygon" ? "Area and fit are calculated from boundary corners." : <>Est. Area: <strong className="text-emerald-400">
                {(
                  (Number(measuredWidth) || 0) * (Number(measuredLength) || 0)
                ).toLocaleString()} {unit === "m" ? "m²" : "sq ft"}
              </strong></>}
            </div>
          </div>
        </div>

        {landShape === "polygon" && (
          <div>
            <label htmlFor={polygonInputId} className="block text-xs font-medium text-slate-400 mb-1">
              Boundary Corner Coordinates (lat, lng per line):
            </label>
            <textarea
              id={polygonInputId}
              value={polygonCoordsText}
              onChange={(e) => setPolygonCoordsText(e.target.value)}
              placeholder="12.9716, 77.5946&#10;12.9720, 77.5950&#10;12.9715, 77.5955"
              rows={3}
              className="w-full rounded-xl border border-slate-800 bg-slate-900/80 p-2.5 font-mono text-xs text-slate-200 outline-none focus:border-emerald-500"
            />
          </div>
        )}
      </div>

      {inputError && <p role="alert" className="text-xs text-rose-300">{inputError}</p>}
      {/* Create Canvas Action Button */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <Button
          onClick={handleCreateCanvas}
          className="w-full sm:w-auto bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 font-semibold shadow-lg shadow-emerald-950/40"
        >
          ✨ Create Canvas from Measured Land
        </Button>

        {createdFeedback && (
          <p role="status" className="text-xs font-medium text-emerald-400">
            {createdFeedback}
          </p>
        )}
      </div>
    </div>
  );
}
