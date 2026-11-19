"use client";

import { useEffect } from "react";
import { digestOf, ErrorState, PAYMENT_SAFE_COPY } from "@/components/ErrorState";

/** Errors in checkout or the return page: shown inside the checkout shell. */
export default function CheckoutError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => console.error("[error-boundary] checkout", error), [error]);
  return (
    <ErrorState
      title="Something went wrong with checkout"
      body={<>We couldn&rsquo;t load this step. {PAYMENT_SAFE_COPY} Nothing is charged by opening this page again.</>}
      reference={digestOf(error)}
      onRetry={retry}
    />
  );
}
