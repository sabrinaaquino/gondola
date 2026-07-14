"use client";

import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Entity fatal error:", error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#05070d", color: "#e7ecf5", fontFamily: "system-ui, sans-serif", padding: "24px" }}>
          <div style={{ maxWidth: "440px", textAlign: "center" }}>
            <h1 style={{ fontSize: "1.4rem", marginBottom: "12px" }}>The app needs to restart</h1>
            <p style={{ opacity: 0.75, lineHeight: 1.5, marginBottom: "20px" }}>
              A fatal error occurred, but your local data is safe. Restart the interface to continue.
            </p>
            <button
              onClick={reset}
              style={{ padding: "10px 22px", borderRadius: "999px", border: "none", background: "#5b8cff", color: "#fff", fontWeight: 600, cursor: "pointer" }}
            >
              Restart
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
