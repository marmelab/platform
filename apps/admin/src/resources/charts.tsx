// Load charts (app_metrics, journeys A3 and A9): a 7-day sparkline for the apps list and the dashboard, and an hourly
// stacked bar chart for the app page. Plain SVG; requests and 5xx use the --viz-* tokens (index.css), text stays in the
// text tokens; every mark has a hover tooltip, and the hourly chart has a table view.
import { useState } from "react";

export interface Day {
  day: string;
  requests: number;
  errors: number;
}

export interface Hour {
  hour: string;
  requests: number;
  responses_5xx: number;
  db_size_bytes: number | null;
  memory_bytes: number | null;
}

const number = new Intl.NumberFormat();
export const count = (n: number | null | undefined) => (n === null || n === undefined ? "—" : number.format(n));
const dayLabel = (day: string) => new Date(day).toLocaleDateString(undefined, { weekday: "short", day: "numeric", timeZone: "UTC" });
const hourLabel = (hour: string) =>
  new Date(hour).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

/**
 * Requests per UTC day over 7 days: one thin bar per day (5xx stacked on top), tooltip per bar. A single measure, so no
 * legend: the column title names it.
 */
export function Sparkline({ days, label }: { days: Day[] | null | undefined; label: string }) {
  if (!days?.length) return <span className="text-muted-foreground">—</span>;
  const width = 7 * 10;
  const height = 22;
  const max = Math.max(1, ...days.map((d) => d.requests));
  const total = days.reduce((n, d) => n + d.requests, 0);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${label}: ${count(total)} requests over 7 days`}
      className="overflow-visible"
    >
      <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} stroke="var(--border)" />
      {days.map((d, i) => {
        const h = d.requests ? Math.max(2, (d.requests / max) * (height - 2)) : 0;
        const e = d.requests ? (d.errors / d.requests) * h : 0;
        return (
          <g key={d.day}>
            <title>{`${dayLabel(d.day)}: ${count(d.requests)} requests, ${count(d.errors)} 5xx`}</title>
            {/* hit target bigger than the mark */}
            <rect x={i * 10} y={0} width={10} height={height} fill="transparent" />
            {h > 0 && <rect x={i * 10 + 2} y={height - h} width={6} height={h - e} rx={1} fill="var(--viz-requests)" />}
            {e > 0 && <rect x={i * 10 + 2} y={height - e} width={6} height={e} fill="var(--viz-errors)" />}
          </g>
        );
      })}
    </svg>
  );
}

/** Requests per hour, 5xx stacked, with a legend, a crosshair tooltip and a table of the non-empty hours. */
export function HourlyChart({ hours }: { hours: Hour[] }) {
  const [active, setActive] = useState<number | null>(null);
  const width = 720;
  const height = 160;
  const pad = { top: 8, right: 8, bottom: 20, left: 44 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...hours.map((h) => h.requests));
  const step = plotW / Math.max(1, hours.length);
  const bar = Math.max(1, step - 1);
  const y = (v: number) => pad.top + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max].map((v) => Math.round(v));
  const current = active === null ? null : hours[active];
  const days = hours.filter((h) => new Date(h.hour).getUTCHours() === 0);
  return (
    <figure className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block size-2.5 rounded-sm" style={{ background: "var(--viz-requests)" }} /> requests
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block size-2.5 rounded-sm" style={{ background: "var(--viz-errors)" }} /> 5xx responses
        </span>
        <span className="ml-auto min-h-4 text-foreground" aria-live="polite">
          {current ? `${hourLabel(current.hour)} UTC: ${count(current.requests)} requests, ${count(current.responses_5xx)} 5xx` : ""}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Requests per hour: ${count(hours.reduce((n, h) => n + h.requests, 0))} over the period`}
        onMouseLeave={() => setActive(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray={t ? "2 3" : undefined} />
            <text x={pad.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--muted-foreground)">
              {count(t)}
            </text>
          </g>
        ))}
        {days.map((d) => {
          const x = pad.left + hours.indexOf(d) * step;
          return (
            <text key={d.hour} x={x} y={height - 6} fontSize={10} fill="var(--muted-foreground)">
              {dayLabel(d.hour)}
            </text>
          );
        })}
        {hours.map((h, i) => {
          const x = pad.left + i * step;
          const top = y(h.requests);
          const errTop = y(h.responses_5xx);
          return (
            <g key={h.hour} onMouseEnter={() => setActive(i)}>
              <rect x={x} y={pad.top} width={step} height={plotH} fill={active === i ? "var(--muted)" : "transparent"} />
              {h.requests > 0 && (
                <rect x={x} y={top} width={bar} height={Math.max(1, y(0) - top)} fill="var(--viz-requests)" />
              )}
              {h.responses_5xx > 0 && (
                <rect x={x} y={errTop} width={bar} height={Math.max(1, y(0) - errTop)} fill="var(--viz-errors)" />
              )}
            </g>
          );
        })}
      </svg>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Table view</summary>
        <table className="mt-2 text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="pr-4 font-normal">Hour (UTC)</th>
              <th className="pr-4 text-right font-normal">Requests</th>
              <th className="text-right font-normal">5xx</th>
            </tr>
          </thead>
          <tbody>
            {hours.filter((h) => h.requests > 0).reverse().map((h) => (
              <tr key={h.hour}>
                <td className="pr-4">{hourLabel(h.hour)}</td>
                <td className="pr-4 text-right tabular-nums">{count(h.requests)}</td>
                <td className="text-right tabular-nums">{count(h.responses_5xx)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
