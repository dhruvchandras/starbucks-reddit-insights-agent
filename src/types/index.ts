export const SUBREDDITS = ["starbucks", "starbucksbaristas"] as const;
export type Subreddit = (typeof SUBREDDITS)[number];

export const CATEGORIES = [
  "barista_experience",
  "customer_experience",
  "operational_efficiency",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Categories that get their own suggestion block in the weekly report. */
export const REPORT_CATEGORIES = CATEGORIES.filter((c) => c !== "other") as Exclude<
  Category,
  "other"
>[];

export const CATEGORY_LABELS: Record<Category, string> = {
  barista_experience: "Barista experience",
  customer_experience: "Customer experience",
  operational_efficiency: "Operational efficiency",
  other: "Other",
};

export interface Post {
  id: string;
  subreddit: Subreddit;
  createdUtc: number;
  title: string;
  selftext: string;
  score: number;
  numComments: number;
  permalink: string;
  linkFlairText: string | null;
  source: "reddit" | "arctic";
}

export interface PostComment {
  id: string;
  postId: string;
  body: string;
  score: number;
}

export interface Extraction {
  postId: string;
  sentiment: number; // -1..1
  category: Category;
  themes: string[];
  summary: string;
  painPoints: string[];
  model: string;
  extractedAt: string;
}

export interface WeeklyAggregate {
  weekStart: string; // YYYY-MM-DD (Monday)
  subreddit: Subreddit | "all";
  category: Category;
  avgSentiment: number;
  postCount: number;
  topThemes: { theme: string; count: number }[];
}

export interface ReportPoint {
  headline: string;
  detail: string;
  evidence: string[]; // reddit permalinks
}

export interface Suggestion {
  category: Exclude<Category, "other">;
  headline: string;
  detail: string;
  evidence: string[];
}

export interface WeeklyReport {
  weekStart: string;
  weekEnd: string;
  whatsWorking: ReportPoint[];
  whatsNotWorking: ReportPoint[];
  suggestions: Suggestion[];
  postCount: number;
  avgSentiment: number | null;
  isBackfilled: boolean;
  generatedAt: string;
}

export interface InsightSnapshot {
  id: number;
  generatedAt: string;
  narrative: string;
  isBaseline: boolean;
  weeksCovered: number;
}

export interface Citation {
  postId: string;
  title: string;
  permalink: string;
  subreddit: string;
  createdUtc: number;
}

export interface QAEntry {
  id: number;
  question: string;
  answer: string;
  citations: Citation[];
  askedAt: string;
}
