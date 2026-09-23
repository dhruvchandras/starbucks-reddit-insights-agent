"use client";

import { useRef, useState } from "react";
import styles from "./Tab.module.css";
import type { Citation } from "@/types";

interface Answer {
  question: string;
  answer: string;
  citations: Citation[];
  retrievedCount: number;
}

const EXAMPLES = [
  "What are baristas complaining about most right now?",
  "How do people feel about mobile ordering?",
  "What's the sentiment on the new drink lineup?",
  "Which operational problems come up week after week?",
];

/** Turn bare permalinks in the model's prose into real links. */
function renderAnswer(text: string) {
  const parts = text.split(/(https?:\/\/[^\s)\]]+)/g);
  return parts.map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer">
        {part.replace(/^https?:\/\/(www\.)?reddit\.com/, "")}
      </a>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export default function QATab() {
  const [question, setQuestion] = useState("");
  const [entries, setEntries] = useState<Answer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  async function ask(q: string) {
    const trimmed = q.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? `Request failed (${res.status}).`);
        return;
      }

      setEntries((prev) => [
        {
          question: trimmed,
          answer: data.answer,
          citations: data.citations ?? [],
          retrievedCount: data.retrievedCount ?? 0,
        },
        ...prev,
      ]);
      setQuestion("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <p className={styles.intro}>
        Answers come only from posts already ingested from r/starbucks and
        r/starbucksbaristas, with links to the threads they came from. Nothing is
        read live and nothing is posted back.
      </p>

      <form
        className={styles.askForm}
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
      >
        <textarea
          ref={inputRef}
          className={styles.askInput}
          value={question}
          placeholder="Ask about what the communities are saying…"
          rows={1}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask(question);
            }
          }}
          disabled={loading}
        />
        <button
          type="submit"
          className={styles.btn}
          disabled={loading || !question.trim()}
        >
          {loading ? "Thinking…" : "Ask"}
        </button>
      </form>

      <div className={styles.suggestions}>
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            className={styles.chip}
            onClick={() => {
              setQuestion(ex);
              inputRef.current?.focus();
            }}
            disabled={loading}
          >
            {ex}
          </button>
        ))}
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {entries.length === 0 && !loading && !error && (
        <div className={styles.empty}>
          No questions yet. If answers come back empty, the corpus may not be
          populated — run <code>npm run backfill</code> first.
        </div>
      )}

      {entries.map((entry, i) => (
        <article key={i} className={styles.qaEntry}>
          <h2 className={styles.question}>{entry.question}</h2>
          <div className={styles.retrievedNote}>
            grounded in {entry.retrievedCount} retrieved post
            {entry.retrievedCount === 1 ? "" : "s"}
          </div>
          <div className={styles.answer}>{renderAnswer(entry.answer)}</div>

          {entry.citations.length > 0 && (
            <div className={styles.citations}>
              <div className={styles.citationsLabel}>Sources</div>
              {entry.citations.map((c) => (
                <div key={c.postId} className={styles.citation}>
                  <span className={styles.citationMeta}>
                    r/{c.subreddit} ·{" "}
                    {new Date(c.createdUtc * 1000).toISOString().slice(0, 10)}
                  </span>
                  <a href={c.permalink} target="_blank" rel="noopener noreferrer">
                    {c.title}
                  </a>
                </div>
              ))}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
