"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import styles from "./Tab.module.css";

/** Fixed slot per category — never reassigned when the view changes. */
const SERIES = [
  { key: "barista_experience", label: "Barista experience", color: "var(--series-barista)" },
  { key: "customer_experience", label: "Customer experience", color: "var(--series-customer)" },
  { key: "operational_efficiency", label: "Operational efficiency", color: "var(--series-ops)" },
] as const;

interface SeriesRow {
  week: string;
  total?: number;
  [key: string]: number | string | undefined;
}

interface ThemeMove {
  theme: string;
  recent: number;
  prior: number;
  delta: number;
}

interface InsightsData {
  series: SeriesRow[];
  themeMovement: ThemeMove[];
  categoryTotals: { category: string; postCount: number; avgSentiment: number }[];
  weekCount: number;
  narrative: string | null;
  narrativeGeneratedAt: string | null;
}

/**
 * Trailing mean. At 156 weekly points the raw line is mostly noise, so the
 * smoothed view is the default; the raw one stays one click away.
 */
function smooth(rows: SeriesRow[], window: number): SeriesRow[] {
  if (window <= 1) return rows;

  return rows.map((row, i) => {
    const out: SeriesRow = { week: row.week, total: row.total };
    for (const s of SERIES) {
      const slice = rows
        .slice(Math.max(0, i - window + 1), i + 1)
        .map((r) => r[s.key])
        .filter((v): v is number => typeof v === "number");
      out[s.key] =
        slice.length > 0
          ? Number((slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(3))
          : undefined;
    }
    return out;
  });
}

function TooltipContent({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { dataKey: string; value: number; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border-strong)",
        borderRadius: 6,
        padding: "8px 11px",
        fontSize: 12.5,
        boxShadow: "0 4px 14px rgba(0,0,0,0.12)",
      }}
    >
      <div
        style={{
          fontFamily: "var(--mono)",
          color: "var(--text-faint)",
          marginBottom: 5,
        }}
      >
        week of {label}
      </div>
      {payload.map((p) => {
        const s = SERIES.find((x) => x.key === p.dataKey);
        return (
          <div
            key={p.dataKey}
            style={{ display: "flex", alignItems: "center", gap: 7, padding: "1px 0" }}
          >
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: 2,
                background: p.color,
                flexShrink: 0,
              }}
            />
            <span style={{ color: "var(--text-dim)" }}>{s?.label ?? p.dataKey}</span>
            <span
              style={{
                marginLeft: "auto",
                fontFamily: "var(--mono)",
                fontVariantNumeric: "tabular-nums",
                color: "var(--text)",
              }}
            >
              {p.value > 0 ? "+" : ""}
              {p.value.toFixed(2)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function InsightsTab({ active }: { active: boolean }) {
  const [data, setData] = useState<InsightsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [smoothing, setSmoothing] = useState(4);
  const [showTable, setShowTable] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/insights");
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `Request failed (${res.status}).`);
        return;
      }
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (active && !loaded && !loading) void load();
  }, [active, loaded, loading, load]);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch("/api/insights/refresh", { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `Refresh failed (${res.status}).`);
        return;
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setRefreshing(false);
    }
  }

  const chartData = useMemo(
    () => (data ? smooth(data.series, smoothing) : []),
    [data, smoothing],
  );

  // Year-month ticks repeat themselves over a short span (several weeks share
  // one month), so switch to day-level labels until the range is long enough.
  const formatTick = useMemo(() => {
    const long = chartData.length > 30;
    return (w: string) =>
      long
        ? w.slice(0, 7)
        : new Date(`${w}T00:00:00Z`).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          });
  }, [chartData.length]);

  const totals = useMemo(() => {
    if (!data) return { posts: 0, sentiment: 0 };
    const posts = data.categoryTotals.reduce((s, c) => s + c.postCount, 0);
    const weighted = data.categoryTotals.reduce(
      (s, c) => s + c.avgSentiment * c.postCount,
      0,
    );
    return { posts, sentiment: posts ? weighted / posts : 0 };
  }, [data]);

  const span = data?.series.length
    ? `${data.series[0].week} → ${data.series[data.series.length - 1].week}`
    : "—";

  return (
    <div>
      <div className={styles.insightsHead}>
        <p className={styles.intro} style={{ margin: 0 }}>
          Sentiment and themes across the whole ingested corpus. Refresh recomputes
          the aggregates and rewrites the narrative — it does not re-download
          history, so it takes seconds.
        </p>
        <button
          className={styles.btnGhost}
          onClick={refresh}
          disabled={refreshing || loading}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {loading && !data && <div className={styles.spinner}>Loading…</div>}

      {loaded && data && data.series.length === 0 && !error && (
        <div className={styles.empty}>
          No aggregates yet. Run <code>npm run backfill</code> to build the
          historical baseline.
        </div>
      )}

      {data && data.series.length > 0 && (
        <>
          <div className={styles.statRow}>
            <div className={styles.stat}>
              <div className={styles.statLabel}>Weeks covered</div>
              <div className={styles.statValue}>{data.weekCount}</div>
              <div className={styles.statSub}>{span}</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.statLabel}>Posts analyzed</div>
              <div className={styles.statValue}>
                {totals.posts.toLocaleString()}
              </div>
              <div className={styles.statSub}>tagged &amp; aggregated</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.statLabel}>Overall sentiment</div>
              <div
                className={styles.statValue}
                style={{
                  color:
                    totals.sentiment > 0.05
                      ? "var(--positive)"
                      : totals.sentiment < -0.05
                        ? "var(--negative)"
                        : "var(--text)",
                }}
              >
                {totals.sentiment > 0 ? "+" : ""}
                {totals.sentiment.toFixed(2)}
              </div>
              <div className={styles.statSub}>−1 to +1, post-weighted</div>
            </div>
          </div>

          <div className={styles.chartWrap}>
            <div className={styles.chartTitle}>Sentiment by category, week over week</div>
            <div className={styles.chartNote}>
              {smoothing > 1
                ? `${smoothing}-week trailing average.`
                : "Raw weekly values."}{" "}
              Above the line is net positive. Historical weeks are sampled at the
              top ~120 posts by engagement; recent weeks are a full ingest.
            </div>

            {/* Legend: identity is never color-alone. */}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "6px 18px",
                padding: "0 8px 12px",
              }}
            >
              {SERIES.map((s) => (
                <span
                  key={s.key}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                    fontSize: 12.5,
                    color: "var(--text-dim)",
                  }}
                >
                  <span
                    style={{
                      width: 11,
                      height: 3,
                      borderRadius: 2,
                      background: s.color,
                    }}
                  />
                  {s.label}
                </span>
              ))}
            </div>

            <ResponsiveContainer width="100%" height={310}>
              <LineChart
                data={chartData}
                margin={{ top: 4, right: 14, bottom: 4, left: -16 }}
              >
                <CartesianGrid stroke="var(--grid)" vertical={false} />
                <XAxis
                  dataKey="week"
                  tick={{ fontSize: 11, fill: "var(--text-faint)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--grid)" }}
                  minTickGap={44}
                  tickFormatter={formatTick}
                />
                <YAxis
                  domain={[-1, 1]}
                  ticks={[-1, -0.5, 0, 0.5, 1]}
                  tick={{ fontSize: 11, fill: "var(--text-faint)" }}
                  tickLine={false}
                  axisLine={false}
                  width={46}
                />
                <ReferenceLine y={0} stroke="var(--zero-line)" strokeWidth={1} />
                <Tooltip
                  content={<TooltipContent />}
                  cursor={{ stroke: "var(--text-faint)", strokeWidth: 1 }}
                />
                {SERIES.map((s) => (
                  <Line
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={s.label}
                    stroke={s.color}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
                    connectNulls
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>

            <div
              style={{
                display: "flex",
                gap: 8,
                padding: "10px 8px 2px",
                flexWrap: "wrap",
              }}
            >
              {[1, 4, 8].map((w) => (
                <button
                  key={w}
                  className={styles.chip}
                  onClick={() => setSmoothing(w)}
                  style={
                    smoothing === w
                      ? { color: "var(--text)", borderColor: "var(--text-faint)" }
                      : undefined
                  }
                >
                  {w === 1 ? "Raw" : `${w}-week avg`}
                </button>
              ))}
              <button
                className={styles.chip}
                onClick={() => setShowTable((v) => !v)}
                style={{ marginLeft: "auto" }}
              >
                {showTable ? "Hide table" : "View as table"}
              </button>
            </div>

            {showTable && (
              <div style={{ overflowX: "auto", padding: "12px 8px 4px" }}>
                <table
                  style={{
                    borderCollapse: "collapse",
                    fontSize: 12.5,
                    width: "100%",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", padding: "4px 10px 4px 0" }}>
                        Week
                      </th>
                      {SERIES.map((s) => (
                        <th
                          key={s.key}
                          style={{ textAlign: "right", padding: "4px 10px" }}
                        >
                          {s.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...chartData].reverse().map((row) => (
                      <tr key={row.week} style={{ borderTop: "1px solid var(--border)" }}>
                        <td
                          style={{
                            padding: "3px 10px 3px 0",
                            fontFamily: "var(--mono)",
                            color: "var(--text-dim)",
                          }}
                        >
                          {row.week}
                        </td>
                        {SERIES.map((s) => {
                          const v = row[s.key];
                          return (
                            <td
                              key={s.key}
                              style={{ textAlign: "right", padding: "3px 10px" }}
                            >
                              {typeof v === "number" ? v.toFixed(2) : "—"}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {data.themeMovement.length > 0 && (
            <div style={{ marginBottom: 26 }}>
              <div className={styles.chartTitle} style={{ padding: 0 }}>
                Theme movement
              </div>
              <div className={styles.chartNote} style={{ padding: 0 }}>
                Mentions in the last 4 weeks vs. the 8 before, rate-adjusted.
              </div>
              <div className={styles.themeGrid}>
                <div>
                  {data.themeMovement
                    .filter((t) => t.delta > 0)
                    .slice(0, 8)
                    .map((t) => (
                      <div key={t.theme} className={styles.themeRow}>
                        <span>{t.theme}</span>
                        <span className={`${styles.themeDelta} ${styles.deltaUp}`}>
                          +{t.delta.toFixed(0)} ({t.prior}→{t.recent})
                        </span>
                      </div>
                    ))}
                </div>
                <div>
                  {data.themeMovement
                    .filter((t) => t.delta < 0)
                    .slice(0, 8)
                    .map((t) => (
                      <div key={t.theme} className={styles.themeRow}>
                        <span>{t.theme}</span>
                        <span className={`${styles.themeDelta} ${styles.deltaDown}`}>
                          {t.delta.toFixed(0)} ({t.prior}→{t.recent})
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          )}

          <div className={styles.card}>
            <div className={styles.chartTitle} style={{ padding: 0, marginBottom: 4 }}>
              How this has evolved
            </div>
            {data.narrativeGeneratedAt && (
              <div className={styles.chartNote} style={{ padding: 0 }}>
                Written {new Date(data.narrativeGeneratedAt).toLocaleString()}
              </div>
            )}
            {data.narrative ? (
              <div className={styles.narrative}>
                {data.narrative.split(/\n\n+/).map((para, i) => (
                  <p key={i}>{para}</p>
                ))}
              </div>
            ) : (
              <p style={{ color: "var(--text-dim)", fontSize: 14 }}>
                No narrative yet — hit Refresh to write one from the aggregates above.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
