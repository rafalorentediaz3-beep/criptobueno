import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Feedback",
  description:
    "Post and upvote feedback. Token-holder governance, gasless voting, and a weekly reward pot for the best ideas.",
  alternates: { canonical: "/feedback" },
};

export default function FeedbackLayout({ children }: { children: ReactNode }) {
  return children;
}
