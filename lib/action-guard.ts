import "server-only";
import { unstable_rethrow } from "next/navigation";
import { maybeFail } from "./dev-faults";

/*
 * Server actions never throw to the browser. An unexpected error (database locked, a bug)
 * would otherwise reach the nearest error boundary and replace the page; instead it's
 * logged and the form shows `message` inline. redirect() and notFound() still work: they
 * throw internal errors that unstable_rethrow passes through.
 */

/** Plain failure: nothing was charged or changed. */
export const SOMETHING_WENT_WRONG = "Something went wrong on our side, so nothing changed. Please try again.";
/** A failure that may have happened after a card was charged. */
export const CHECK_BILLING_FIRST =
  "Something went wrong and we couldn't confirm what happened. Check Billing before trying again.";

export async function guard<S extends { error: string | null }>(
  name: string,
  message: string,
  fn: () => Promise<S>,
  opts: { testFault?: boolean } = {},
): Promise<S> {
  try {
    // Test tools → Trigger an error → Buttons (development only).
    if (opts.testFault !== false) await maybeFail("actions");
    return await fn();
  } catch (err) {
    unstable_rethrow(err);
    console.error(`[action] ${name} failed`, err);
    return { error: message } as S;
  }
}
