import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Starbucks Reddit Insight Agent",
  description:
    "Synthesized insight from r/starbucks and r/starbucksbaristas — read-only, private.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
