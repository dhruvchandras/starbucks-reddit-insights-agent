import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { answerQuestion } from "@/lib/claude";
import { saveQA, searchPosts } from "@/lib/store";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let question: string;
  try {
    const body = (await req.json()) as { question?: unknown };
    question = typeof body.question === "string" ? body.question.trim() : "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!question) {
    return NextResponse.json({ error: "A question is required." }, { status: 400 });
  }
  if (question.length > 1000) {
    return NextResponse.json(
      { error: "Question is too long (max 1000 characters)." },
      { status: 400 },
    );
  }

  try {
    const retrieved = await searchPosts(question, 40);

    if (retrieved.length === 0) {
      return NextResponse.json({
        answer:
          "Nothing in the ingested corpus matches that question. Either the topic has not come up in r/starbucks or r/starbucksbaristas within the ingested range, or it is phrased differently there — try the words a barista or customer would actually use.",
        citations: [],
        retrievedCount: 0,
      });
    }

    const { answer, citations } = await answerQuestion(question, retrieved);
    await saveQA(question, answer, citations);

    return NextResponse.json({
      answer,
      citations,
      retrievedCount: retrieved.length,
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return NextResponse.json(
        { error: "Rate limited by the Anthropic API. Try again shortly." },
        { status: 429 },
      );
    }
    if (err instanceof Anthropic.APIError) {
      return NextResponse.json(
        { error: `Anthropic API error ${err.status}: ${err.message}` },
        { status: 502 },
      );
    }
    console.error("[api/ask]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error." },
      { status: 500 },
    );
  }
}
