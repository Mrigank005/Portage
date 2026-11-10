import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Brewbox",
  description: "Coffee beans and brewing gear. A Portage test app.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site">
          <div>
            <strong>Brewbox</strong>
            <nav>
              <Link href="/">Shop</Link>
              <Link href="/admin/orders">Orders (admin)</Link>
            </nav>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
