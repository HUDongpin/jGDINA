import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "jGDINA + Next.js",
  description: "Node Route Handler and browser-worker jGDINA examples",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
