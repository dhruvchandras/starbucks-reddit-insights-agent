import type { Post, PostComment, Subreddit } from "@/types";

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const API = "https://oauth.reddit.com";

let cached: { token: string; expiresAt: number } | null = null;

function userAgent(): string {
  return (
    process.env.REDDIT_USER_AGENT ??
    "web:reddit-insight-agent:v1.0 (by /u/unknown)"
  );
}

/**
 * App-only ("client_credentials") token. Read-only by construction: this grant
 * cannot be used to post, vote or comment, and we request no scopes beyond it.
 * Never uses a username/password grant.
 */
export async function getAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error("REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET must be set.");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent(),
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });

  if (!res.ok) {
    throw new Error(
      `Reddit token request failed: ${res.status} ${await res.text()}`,
    );
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  cached = {
    token: json.access_token,
    // Refresh a minute early rather than racing the expiry.
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
  };
  return cached.token;
}

async function apiGet(path: string): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": userAgent() },
  });

  if (res.status === 429) {
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? "60");
    await new Promise((r) => setTimeout(r, (reset + 1) * 1000));
    return apiGet(path);
  }
  if (!res.ok) {
    throw new Error(`Reddit API ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function toPost(child: any, subreddit: Subreddit): Post {
  const d = child.data;
  return {
    id: d.id,
    subreddit,
    createdUtc: Math.floor(d.created_utc),
    title: d.title ?? "",
    selftext: d.selftext ?? "",
    score: d.score ?? 0,
    numComments: d.num_comments ?? 0,
    permalink: `https://reddit.com${d.permalink}`,
    linkFlairText: d.link_flair_text ?? null,
    source: "reddit",
  };
}

/**
 * Walk /new backwards until we reach `sinceUtc` or run out of pages.
 * Reddit caps listings around 1000 items, which is far more than a day's volume
 * for these subs (~150/day combined), so a daily cron never approaches it.
 */
export async function fetchNewPosts(
  subreddit: Subreddit,
  sinceUtc: number,
  maxPages = 10,
): Promise<Post[]> {
  const out: Post[] = [];
  let after: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ limit: "100" });
    if (after) qs.set("after", after);

    const json = await apiGet(`/r/${subreddit}/new?${qs}`);
    const children: any[] = json.data?.children ?? [];
    if (children.length === 0) break;

    let reachedCursor = false;
    for (const c of children) {
      const post = toPost(c, subreddit);
      if (post.createdUtc <= sinceUtc) {
        reachedCursor = true;
        continue;
      }
      out.push(post);
    }

    if (reachedCursor) break;
    after = json.data?.after ?? null;
    if (!after) break;
  }

  return out;
}

/** Top-level comments for a post, highest scored first. */
export async function fetchTopComments(
  subreddit: Subreddit,
  postId: string,
  limit = 5,
): Promise<PostComment[]> {
  const json = await apiGet(
    `/r/${subreddit}/comments/${postId}?limit=${limit * 3}&sort=top&depth=1`,
  );
  const listing = Array.isArray(json) ? json[1] : null;
  const children: any[] = listing?.data?.children ?? [];

  return children
    .filter((c) => c.kind === "t1" && c.data?.body && c.data.body !== "[deleted]")
    .map((c) => ({
      id: c.data.id as string,
      postId,
      body: c.data.body as string,
      score: (c.data.score ?? 0) as number,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
