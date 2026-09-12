import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Moderation Lab",
  description: "Manual test harness for comparing voice moderator architectures",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
