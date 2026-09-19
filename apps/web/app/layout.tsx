import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "GitLit",
  description: "Version control for manuscripts, with verifiable provenance.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="header">
          <div className="wrap header-inner">
            <Link href="/" className="brand">Git<span>Lit</span></Link>
            <span className="tagline">version control for manuscripts</span>
            <span className="spacer" />
            <Link href="/new" className="btn">New book</Link>
          </div>
        </header>
        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}
