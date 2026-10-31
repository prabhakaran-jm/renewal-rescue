import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Renewal Rescue — Recovery Desk",
  description:
    "Merchant desk: failed renewal / outstanding → AI propose → policy → Approve capture or revise",
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
