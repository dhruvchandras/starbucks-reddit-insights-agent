"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./Tab.module.css";
import { CATEGORY_LABELS, REPORT_CATEGORIES } from "@/types";
import type { ReportPoint, Suggestion, WeeklyReport } from "@/types";

const PAGE_SIZE = 8;

function formatWeek(start: string, end: string): string {
  const s = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${end}T00:00:00Z`);
  const month = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  const sameMonth = s.getUTCMonth() === e.getUTCMonth();

  return sameMonth
    ? `${month(s)} ${s.getUTCDate()}–${e.getUTCDate()}, ${e.getUTCFullYear()}`
    : `${month(s)} ${s.getUTCDate()} – ${month(e)} ${e.getUTCDate()}, ${e.getUTCFullYear()}`;
}

function Evidence({ urls }: { urls: string[] }) {
  if (urls.length === 0) return null;
  return (
    <div className={styles.evidence}>
      {urls.map((url, i) => (
        <a
          key={url}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.evidenceLink}
        >
          [{i + 1}]
        </a>
      ))}
    </div>
  );
}

function Point({ point, kind }: { point: ReportPoint; kind: "working" | "not" }) {
  return (
    <div
      className={`${styles.point} ${
        kind === "working" ? styles.pointWorking : styles.pointNot
      }`}
    >
      <div className={styles.pointHead}>{point.headline}</div>
      <div className={styles.pointDetail}>{point.detail}</div>
      <Evidence urls={point.evidence} />
    </div>
  );
}

function Entry({ report }: { report: WeeklyReport }) {
  const byCategory = REPORT_CATEGORIES.map((cat) => ({
    cat,
    items: report.suggestions.filter((s: Suggestion) => s.category === cat),
  })).filter((g) => g.items.length > 0);

  return (
    <article className={styles.entry} id={`week-${report.weekStart}`}>
      <header className={styles.entryHead}>
        <h2 className={styles.entryWeek}>
          {formatWeek(report.weekStart, report.weekEnd)}
        </h2>
        <div className={styles.entryMeta}>
          <span>{report.postCount.toLocaleString()} posts analyzed</span>
          {report.avgSentiment !== null && (
            <span>mean sentiment {report.avgSentiment.toFixed(2)}</span>
          )}
          {report.isBackfilled && (
            <span className={styles.backfillBadge}>
              sampled baseline — top posts only
            </span>
          )}
        </div>
      </header>

      {report.whatsWorking.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>What&rsquo;s working</h3>
          {report.whatsWorking.map((p, i) => (
            <Point key={i} point={p} kind="working" />
          ))}
        </section>
      )}

      {report.whatsNotWorking.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>What&rsquo;s not working</h3>
          {report.whatsNotWorking.map((p, i) => (
            <Point key={i} point={p} kind="not" />
          ))}
        </section>
      )}

      {byCategory.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Tactical suggestions</h3>
          {byCategory.map((group) => (
            <div key={group.cat} className={styles.suggestionGroup}>
              <div className={styles.suggestionGroupTitle}>
                {CATEGORY_LABELS[group.cat]}
              </div>
              {group.items.map((s, i) => (
                <div key={i} className={styles.suggestion}>
                  <span className={styles.suggestionNum}>{i + 1}.</span>
                  <div>
                    <div className={styles.pointHead}>{s.headline}</div>
                    <div className={styles.pointDetail}>{s.detail}</div>
                    <Evidence urls={s.evidence} />
                  </div>
                </div>
              ))}
            </div>
          ))}
        </section>
      )}
    </article>
  );
}

export default function WeeklyTab({ active }: { active: boolean }) {
  const [reports, setReports] = useState<WeeklyReport[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const loadPage = useCallback(
    async (before: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (before) qs.set("before", before);

        const res = await fetch(`/api/reports?${qs}`);
        const data = await res.json();

        if (!res.ok) {
          setError(data.error ?? `Request failed (${res.status}).`);
          setHasMore(false);
          return;
        }

        setReports((prev) => {
          const seen = new Set(prev.map((r) => r.weekStart));
          return [
            ...prev,
            ...(data.reports as WeeklyReport[]).filter((r) => !seen.has(r.weekStart)),
          ];
        });
        setHasMore(Boolean(data.hasMore));
        setCursor(data.nextCursor ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error.");
        setHasMore(false);
      } finally {
        setLoading(false);
        setLoaded(true);
      }
    },
    [],
  );

  useEffect(() => {
    if (active && !loaded && !loading) void loadPage(null);
  }, [active, loaded, loading, loadPage]);

  // Page in older entries as the bottom of the feed comes into view.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !active || !hasMore || loading || !loaded) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadPage(cursor);
      },
      { rootMargin: "600px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [active, hasMore, loading, loaded, cursor, loadPage]);

  return (
    <div>
      <div className={styles.feedHeader}>
        <p className={styles.intro} style={{ margin: 0 }}>
          One entry per week, newest first. Each is built from that week&rsquo;s posts
          only. Scroll for older weeks.
        </p>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {loaded && reports.length === 0 && !error && (
        <div className={styles.empty}>
          No weekly reports yet. Run <code>npm run backfill</code> to seed the last
          12 weeks, or trigger <code>/api/cron/weekly-report</code> for a single week.
        </div>
      )}

      {reports.map((r) => (
        <Entry key={r.weekStart} report={r} />
      ))}

      <div ref={sentinelRef} className={styles.sentinel} />

      {loading && <div className={styles.feedFoot}>Loading…</div>}
      {!hasMore && reports.length > 0 && (
        <div className={styles.feedFoot}>
          That&rsquo;s the whole archive — {reports.length} week
          {reports.length === 1 ? "" : "s"}.
        </div>
      )}
    </div>
  );
}
