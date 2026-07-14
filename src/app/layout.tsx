import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gondola",
  description: "A local multimodal voice companion powered entirely by Venice and orchestrated with Pi.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
