"use client";

import "./globals.css";
import { useEffect } from "react";
import { digestOf, ErrorState, PAYMENT_SAFE_COPY } from "@/components/ErrorState";

/** Last resort: the root layout itself failed. Renders its own document. */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => console.error("[error-boundary] global", error), [error]);
  return (
    <html lang="en">
      <body>
        <title>Something went wrong · Fieldnote</title>
        <main className="focus-main" id="main">
          <ErrorState
            title="Something went wrong"
            body={<>This is a problem on our side. {PAYMENT_SAFE_COPY}</>}
            reference={digestOf(error)}
            onRetry={retry}
          />
        </main>
      </body>
    </html>
  );
}
