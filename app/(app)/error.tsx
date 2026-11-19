"use client";

import { useEffect } from "react";
import { digestOf, ErrorState, PAYMENT_SAFE_COPY } from "@/components/ErrorState";

/** Errors in Billing or Plans: shown inside the app shell, so the navigation stays. */
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => console.error("[error-boundary] app", error), [error]);
  return (
    <ErrorState
      title="Something went wrong loading this page"
      body={<>This is a problem on our side. {PAYMENT_SAFE_COPY}</>}
      reference={digestOf(error)}
      onRetry={retry}
    />
  );
}
