"use client";

import { useEffect } from "react";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Entity interface error:", error);
  }, [error]);

  return (
    <main className="crash-shell">
      <div className="crash-card">
        <span className="crash-mark"><i /><i /><i /></span>
        <h1>The interface hit a snag</h1>
        <p>
          Something in the interface stopped unexpectedly. Your conversations and memory are saved locally, so nothing was
          lost. You can recover the session without reloading.
        </p>
        {error.message && <code className="crash-detail">{error.message}</code>}
        <div className="crash-actions">
          <button className="crash-primary" onClick={reset}>Try again</button>
          <button className="crash-secondary" onClick={() => window.location.reload()}>Reload the app</button>
        </div>
      </div>
    </main>
  );
}
