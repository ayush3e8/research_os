import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Moderation Lab",
  description: "Manual test harness for comparing voice moderator architectures",
};

const NAV_LINKS = [
  { href: "/", label: "Test call" },
  { href: "/simulations", label: "Simulations" },
  { href: "/evaluations", label: "Evaluations" },
  { href: "/operations", label: "Operations" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* This app has no client-side routing between pages otherwise --
            every route (/, /simulations, /evaluations, /operations) only
            existed by typing its URL directly, with nothing on-screen
            linking to any of them. */}
        <nav
          style={{
            display: "flex",
            gap: 16,
            maxWidth: 960,
            margin: "0 auto 16px",
            paddingBottom: 10,
            borderBottom: "1px solid var(--border)",
            fontSize: 13,
          }}
        >
          {NAV_LINKS.map((link) => (
            <a key={link.href} href={link.href} style={{ color: "var(--text)", textDecoration: "none" }}>
              {link.label}
            </a>
          ))}
        </nav>
        {children}
      </body>
    </html>
  );
}
