import { useEffect, useState } from "react";
import { warehouseHour } from "../../lib/goal";
import { BASE, FORKLIFT_A, FORKLIFT_B, TRUCK_IN, TRUCK_OUT } from "./warehouseLayers";

export type Sky = "day" | "dawn" | "dusk" | "night";

/** What the sky is doing at the warehouse at this hour. */
export function skyAt(hour: number): Sky {
  if (hour >= 7 && hour < 17) return "day";
  if (hour >= 5 && hour < 7) return "dawn";
  if (hour >= 17 && hour < 20) return "dusk";
  return "night";
}

const SKY_TINT: Record<Sky, string> = {
  day: "rgba(255, 255, 255, 0)",
  dawn: "rgba(255, 196, 140, 0.16)",
  dusk: "rgba(255, 150, 90, 0.18)",
  night: "rgba(20, 34, 78, 0.34)",
};

const SKY_TICK_MS = 60_000;

/** The isometric warehouse. The picture is generated (scripts/warehouse_layers.py)
 * and holds no user data, which is why it is set as markup. */
export function WarehouseMap({
  zoom = 1, timezone, dayNight = false, motion = false, arrivals = 0, departures = 0, decorative = false,
}: {
  zoom?: number;
  timezone?: string | null;
  /** Tint the picture by the warehouse's hour. */
  dayNight?: boolean;
  /** Forklifts potter about and trucks drive in and out. */
  motion?: boolean;
  /** Goes up by one each time a truck should drive in. */
  arrivals?: number;
  /** Goes up by one each time a truck should drive off. */
  departures?: number;
  decorative?: boolean;
}) {
  const [sky, setSky] = useState<Sky>(() => skyAt(warehouseHour(timezone)));
  useEffect(() => {
    if (!dayNight) return;
    setSky(skyAt(warehouseHour(timezone)));
    const t = setInterval(() => setSky(skyAt(warehouseHour(timezone))), SKY_TICK_MS);
    return () => clearInterval(t);
  }, [timezone, dayNight]);

  return (
    <div className="relative w-full max-w-[1540px] mx-auto overflow-hidden">
      <div style={{ transform: `scale(${zoom})`, transition: "transform 0.25s ease-out", transformOrigin: "50% 50%" }}>
        <svg
          viewBox="0 0 1540 960"
          className="block w-full h-auto"
          style={{ fontFamily: "Manrope, system-ui, sans-serif" }}
          {...(decorative
            ? { "aria-hidden": true }
            : { role: "img", "aria-label": "Pretend warehouse with Arriving, Stored and Leaving zones, trucks, forklifts and pallets" })}
        >
          <g transform="translate(680 70)">
            <g dangerouslySetInnerHTML={{ __html: BASE }} />
            <g className={motion ? "wm-fork-a" : undefined} data-layer="forklift" dangerouslySetInnerHTML={{ __html: FORKLIFT_A }} />
            <g className={motion ? "wm-fork-b" : undefined} data-layer="forklift" dangerouslySetInnerHTML={{ __html: FORKLIFT_B }} />
            <g
              key={`in-${arrivals}`}
              data-layer="truck-in"
              className={motion && arrivals > 0 ? "wm-drive-in" : undefined}
              dangerouslySetInnerHTML={{ __html: TRUCK_IN }}
            />
            <g
              key={`off-${departures}`}
              data-layer="truck-out"
              className={motion && departures > 0 ? "wm-drive-off" : undefined}
              dangerouslySetInnerHTML={{ __html: TRUCK_OUT }}
            />
          </g>
        </svg>
      </div>
      {dayNight && (
        <div
          aria-hidden="true"
          data-sky={sky}
          className="absolute inset-0 pointer-events-none"
          style={{ background: SKY_TINT[sky], transition: "background 2s ease" }}
        />
      )}
    </div>
  );
}
