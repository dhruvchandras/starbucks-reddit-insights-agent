import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod";
import {
  EXTRACTION_SYSTEM,
  NARRATIVE_SYSTEM,
  QA_SYSTEM,
  SYNTHESIS_SYSTEM,
} from "./taxonomy";
import { CATEGORIES } from "@/types";
import type {
  Category,
  Citation,
  Extraction,
  Post,
  PostComment,
  ReportPoint,
  Suggestion,
  WeeklyAggregate,
} from "@/types";

export const EXTRACT_MODEL = "claude-haiku-4-5";
export const SYNTH_MODEL = "claude-opus-5";

let client: Anthropic | null = null;
export function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

// ─── Per-post extraction (Haiku 4.5) ─────────────────────────────────────────

/**
 * Deliberately permissive. Structured output does not reliably enforce
 * `maxItems`/numeric bounds, and a strict schema here throws away the whole
 * batch over one over-long theme list. Bounds are applied in `toExtractions`
 * instead, where an overage costs a slice rather than 20 posts of work.
 */
const ExtractionItem = z.object({
  ref: z.number().int(),
  sentiment: z.number(),
  category: z.enum(CATEGORIES as unknown as [Category, ...Category[]]),
  themes: z.array(z.string()),
  summary: z.string(),
  pain_points: z.array(z.string()),
});
const ExtractionBatch = z.object({ items: z.array(ExtractionItem) });

/** Clip post bodies so one runaway post cannot blow up a whole batch. */
function renderPost(p: Post, ref: number, comments: PostComment[] = []): string {
  const body = p.selftext.slice(0, 1500);
  const c = comments
    .slice(0, 5)
    .map((x) => "  - (" + x.score + ") " + x.body.slice(0, 300))
    .join("\n");
  return [
    '<post ref="' + ref + '">',
    "subreddit: r/" + p.subreddit,
    "flair: " + (p.linkFlairText ?? "none"),
    "score: " + p.score + " | comments: " + p.numComments,
    "title: " + p.title,
    body ? "body: " + body : "body: (none)",
    c ? "top comments:\n" + c : "",
    "</post>",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface ExtractResult {
  extractions: Extraction[];
  usage: { input: number; output: number; cacheRead: number; cacheCreate: number };
}

/**
 * Request params for tagging one group of posts. Shared by the live path
 * (messages.parse) and the backfill's Batch API path, so both send byte-identical
 * prompts and hit the same cached prefix.
 */
export function buildExtractionParams(
  posts: Post[],
  commentsByPost: Map<string, PostComment[]> = new Map(),
) {
  const rendered = posts
    .map((p, i) => renderPost(p, i, commentsByPost.get(p.id) ?? []))
    .join("\n\n");

  return {
    model: EXTRACT_MODEL,
    max_tokens: 4096,
    system: [
      {
        type: "text" as const,
        text: EXTRACTION_SYSTEM,
        cache_control: { type: "ephemeral" as const },
      },
    ],
    messages: [
      {
        role: "user" as const,
        content:
          'Tag each post below. Return one item per post, with "ref" set to that post\'s ref attribute. Return exactly ' +
          posts.length +
          " items.\n\n" +
          rendered,
      },
    ],
    output_config: { format: zodOutputFormat(ExtractionBatch) },
  };
}

/** Turn a model response into Extraction rows, discarding anything unmatched. */
export function toExtractions(
  items: z.infer<typeof ExtractionItem>[],
  posts: Post[],
): Extraction[] {
  const now = new Date().toISOString();
  const out: Extraction[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const post = posts[item.ref];
    if (!post) continue; // model returned a ref we did not send

    // The model occasionally emits the same ref twice. Two rows for one post
    // makes Postgres reject the whole statement ("ON CONFLICT DO UPDATE command
    // cannot affect row a second time"), which would discard the entire group.
    // First tagging wins.
    if (seen.has(post.id)) continue;
    seen.add(post.id);
    out.push({
      postId: post.id,
      sentiment: Math.max(-1, Math.min(1, item.sentiment)),
      category: item.category,
      themes: item.themes
        .map((t) => t.toLowerCase().trim())
        .filter(Boolean)
        .slice(0, 4),
      summary: item.summary,
      painPoints: item.pain_points.filter(Boolean).slice(0, 3),
      model: EXTRACT_MODEL,
      extractedAt: now,
    });
  }
  return out;
}

/** Parse a raw (unparsed) message — the Batch API path has no parse helper. */
export function parseExtractionText(text: string, posts: Post[]): Extraction[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const result = ExtractionBatch.safeParse(json);
  if (!result.success) return [];
  return toExtractions(result.data.items, posts);
}

/**
 * Tag a batch of posts in one call. The rubric sits in a cached system block;
 * only the posts vary, so the prefix is reused across every batch in a run.
 */
export async function extractBatch(
  posts: Post[],
  commentsByPost: Map<string, PostComment[]> = new Map(),
): Promise<ExtractResult> {
  if (posts.length === 0) {
    return {
      extractions: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    };
  }

  const res = await getClient().messages.parse(
    buildExtractionParams(posts, commentsByPost),
  );

  return {
    extractions: toExtractions(res.parsed_output?.items ?? [], posts),
    usage: {
      input: res.usage.input_tokens,
      output: res.usage.output_tokens,
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
      cacheCreate: res.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

// ─── Weekly synthesis (Opus 5) ───────────────────────────────────────────────

const ReportPointSchema = z.object({
  headline: z.string(),
  detail: z.string(),
  evidence: z.array(z.string()),
});
const WeeklyReportSchema = z.object({
  whats_working: z.array(ReportPointSchema),
  whats_not_working: z.array(ReportPointSchema),
  suggestions: z.array(
    z.object({
      category: z.enum([
        "barista_experience",
        "customer_experience",
        "operational_efficiency",
      ]),
      headline: z.string(),
      detail: z.string(),
      evidence: z.array(z.string()),
    }),
  ),
});

export interface WeekSample {
  permalink: string;
  subreddit: string;
  title: string;
  summary: string;
  sentiment: number;
  category: string;
  themes: string[];
  painPoints: string[];
  score: number;
}

export interface WeekInput {
  weekStart: string;
  weekEnd: string;
  aggregates: WeeklyAggregate[];
  priorAggregates: WeeklyAggregate[];
  samples: WeekSample[];
  isBackfilled: boolean;
}

export async function synthesizeWeek(input: WeekInput): Promise<{
  whatsWorking: ReportPoint[];
  whatsNotWorking: ReportPoint[];
  suggestions: Suggestion[];
}> {
  const aggTable = input.aggregates
    .map(
      (a) =>
        a.category +
        " | posts " +
        a.postCount +
        " | mean sentiment " +
        a.avgSentiment.toFixed(2) +
        " | themes " +
        a.topThemes
          .slice(0, 8)
          .map((t) => t.theme + "(" + t.count + ")")
          .join(", "),
    )
    .join("\n");

  const priorTable = input.priorAggregates
    .map(
      (a) =>
        a.category +
        " | posts " +
        a.postCount +
        " | mean sentiment " +
        a.avgSentiment.toFixed(2),
    )
    .join("\n");

  const sampleBlock = input.samples
    .map(
      (s) =>
        "- [" +
        s.category +
        " | sentiment " +
        s.sentiment.toFixed(2) +
        " | score " +
        s.score +
        "] " +
        s.title +
        "\n  " +
        s.summary +
        "\n  themes: " +
        (s.themes.join(", ") || "none") +
        "\n  pain: " +
        (s.painPoints.join("; ") || "none") +
        "\n  " +
        s.permalink,
    )
    .join("\n");

  const caveat = input.isBackfilled
    ? "\n\nNOTE: this week comes from the historical baseline, sampled at the top ~120 posts by engagement rather than a full ingest. Low-engagement posts are absent. Weight your confidence accordingly."
    : "";

  const stream = getClient().messages.stream({
    model: SYNTH_MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: zodOutputFormat(WeeklyReportSchema),
    },
    system: [
      { type: "text", text: SYNTHESIS_SYSTEM, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content:
          "Week of " +
          input.weekStart +
          " to " +
          input.weekEnd +
          ".\n\nTHIS WEEK BY CATEGORY:\n" +
          (aggTable || "(no data)") +
          "\n\nPRIOR WEEK BY CATEGORY (for direction of travel):\n" +
          (priorTable || "(no prior week)") +
          "\n\nREPRESENTATIVE POSTS (" +
          input.samples.length +
          "):\n" +
          (sampleBlock || "(none)") +
          caveat +
          "\n\nWrite the brief. Cite only permalinks that appear above.",
      },
    ],
  });

  const msg = await stream.finalMessage();
  const parsed = (msg as { parsed_output?: z.infer<typeof WeeklyReportSchema> | null })
    .parsed_output;

  if (!parsed) {
    throw new Error(
      "Weekly synthesis returned no parseable output (stop_reason: " +
        msg.stop_reason +
        ")",
    );
  }

  // Drop any permalink the model produced that was not in the input.
  const valid = new Set(input.samples.map((s) => s.permalink));
  const clean = (e: string[]) => e.filter((url) => valid.has(url));

  return {
    whatsWorking: parsed.whats_working.map((p) => ({ ...p, evidence: clean(p.evidence) })),
    whatsNotWorking: parsed.whats_not_working.map((p) => ({
      ...p,
      evidence: clean(p.evidence),
    })),
    suggestions: parsed.suggestions.map((s) => ({ ...s, evidence: clean(s.evidence) })),
  };
}

// ─── Q&A (Opus 5) ────────────────────────────────────────────────────────────

export type RetrievedPost = Post & {
  summary: string | null;
  sentiment: number | null;
  category: string | null;
};

export async function answerQuestion(
  question: string,
  retrieved: RetrievedPost[],
): Promise<{ answer: string; citations: Citation[] }> {
  const context = retrieved
    .map(
      (p) =>
        "- [r/" +
        p.subreddit +
        " | " +
        new Date(p.createdUtc * 1000).toISOString().slice(0, 10) +
        " | score " +
        p.score +
        " | " +
        (p.category ?? "untagged") +
        (p.sentiment !== null ? " | sentiment " + p.sentiment.toFixed(2) : "") +
        "] " +
        p.title +
        "\n  " +
        (p.summary ?? p.selftext.slice(0, 300)) +
        "\n  " +
        p.permalink,
    )
    .join("\n");

  const res = await getClient().messages.create({
    model: SYNTH_MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system: [{ type: "text", text: QA_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content:
          "RETRIEVED POSTS (" +
          retrieved.length +
          "):\n" +
          (context || "(nothing matched)") +
          "\n\nQUESTION: " +
          question,
      },
    ],
  });

  const answer = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  // Only surface posts the answer actually referenced.
  const citations: Citation[] = retrieved
    .filter((p) => answer.includes(p.permalink))
    .map((p) => ({
      postId: p.id,
      title: p.title,
      permalink: p.permalink,
      subreddit: p.subreddit,
      createdUtc: p.createdUtc,
    }));

  return { answer, citations };
}

// ─── Long-range narrative (Opus 5) ───────────────────────────────────────────

export interface NarrativeRow {
  weekStart: string;
  category: string;
  avgSentiment: number;
  postCount: number;
  topThemes: { theme: string; count: number }[];
}

export async function writeNarrative(rows: NarrativeRow[]): Promise<string> {
  const table = rows
    .map(
      (r) =>
        r.weekStart +
        " | " +
        r.category +
        " | n=" +
        r.postCount +
        " | sentiment " +
        r.avgSentiment.toFixed(2) +
        " | " +
        r.topThemes
          .slice(0, 5)
          .map((t) => t.theme)
          .join(", "),
    )
    .join("\n");

  const res = await getClient().messages.create({
    model: SYNTH_MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system: [
      { type: "text", text: NARRATIVE_SYSTEM, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content:
          "WEEKLY AGGREGATES (oldest first):\n" +
          table +
          "\n\nDescribe how sentiment and themes evolved over this period.",
      },
    ],
  });

  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
