"use client";

import { useEffect } from "react";
import { digestOf, ErrorState, PAYMENT_SAFE_COPY } from "@/components/ErrorState";
import { Wordmark } from "@/components/Wordmark";

/** Errors in the app or checkout layouts themselves (e.g. the top bar): a minimal shell. */
export default function RootError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => console.error("[error-boundary] layout", error), [error]);
  return (
    <div className="shell shell-focus">
      <header className="topbar">
        <Wordmark />
      </header>
      <main className="focus-main" id="main">
        <ErrorState
          title="Something went wrong"
          body={<>This is a problem on our side. {PAYMENT_SAFE_COPY}</>}
          reference={digestOf(error)}
          onRetry={retry}
        />
      </main>
    </div>
  );
}
