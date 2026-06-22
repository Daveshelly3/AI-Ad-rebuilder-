import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI-Ad Rebuilder",
  description:
    "Upload an AI-generated ad and rebuild it with the exact information over a photorealistic, theme-matched background.",
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
