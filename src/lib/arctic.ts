import type { Post, PostComment, Subreddit } from "@/types";

const BASE = "https://arctic-shift.photon-reddit.com";

/**
 * Arctic Shift is the maintained public successor to Pushshift and the only
 * practical way to reach back more than ~1000 posts per subreddit, which is
 * where Reddit's own listing endpoints stop. Free and unauthenticated; the
 * maintainer offers no uptime guarantee, so every caller must tolerate 429s
 * and transient failures.
 */
// `permalink` is rejected by the fields filter (400, "not a valid field") even
// though it exists on the full record, so we build the URL from the id instead —
// reddit.com/r/<sub>/comments/<id> resolves to the same thread.
const FIELDS = [
  "id",
  "created_utc",
  "title",
  "selftext",
  "score",
  "num_comments",
  "link_flair_text",
].join(",");

export async function fetchDay(
  subreddit: Subreddit,
  day: string, // YYYY-MM-DD
  attempt = 0,
): Promise<Post[]> {
  const qs = new URLSearchParams({
    subreddit,
    after: day,
    before: `${day}T23:59:59`,
    limit: "auto",
    fields: FIELDS,
  });

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/posts/search?${qs}`, {
      headers: { "User-Agent": "reddit-insight-agent/1.0 (personal research)" },
    });
  } catch (err) {
    if (attempt >= 4) throw err;
    await sleep(2000 * 2 ** attempt);
    return fetchDay(subreddit, day, attempt + 1);
  }

  if (res.status === 429) {
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? "5");
    await sleep((reset + 1) * 1000);
    return fetchDay(subreddit, day, attempt);
  }
  if (res.status >= 500) {
    if (attempt >= 4) {
      throw new Error(`Arctic Shift ${day} failed after retries: ${res.status}`);
    }
    await sleep(2000 * 2 ** attempt);
    return fetchDay(subreddit, day, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Arctic Shift ${day} failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as { data: any[] };
  return (json.data ?? [])
    .filter((d) => d?.id)
    .map((d) => ({
      id: d.id as string,
      subreddit,
      createdUtc: Math.floor(d.created_utc),
      title: d.title ?? "",
      selftext: typeof d.selftext === "string" ? d.selftext : "",
      score: d.score ?? 0,
      numComments: d.num_comments ?? 0,
      permalink: `https://reddit.com/r/${subreddit}/comments/${d.id}`,
      linkFlairText: d.link_flair_text ?? null,
      source: "arctic" as const,
    }));
}

/**
 * Top-level comments for a post, highest scored first. `link_id` takes the bare
 * post id here, without the `t3_` prefix Reddit's own API expects.
 */
export async function fetchComments(
  postId: string,
  limit = 5,
): Promise<PostComment[]> {
  const qs = new URLSearchParams({
    link_id: postId,
    limit: String(Math.min(limit * 4, 100)),
    fields: "id,body,score,parent_id",
  });

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/comments/search?${qs}`, {
      headers: { "User-Agent": "reddit-insight-agent/1.0 (personal research)" },
    });
  } catch {
    return []; // comments are enrichment, never worth failing an ingest over
  }

  if (!res.ok) return [];

  const json = (await res.json()) as { data?: any[] };
  return (json.data ?? [])
    .filter(
      (c) => c?.id && typeof c.body === "string" && c.body !== "[deleted]",
    )
    .map((c) => ({
      id: c.id as string,
      postId,
      body: c.body as string,
      score: (c.score ?? 0) as number,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
