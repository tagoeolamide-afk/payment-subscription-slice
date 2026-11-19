import type { Metadata } from "next";
import { ErrorState } from "@/components/ErrorState";
import { Wordmark } from "@/components/Wordmark";

export const metadata: Metadata = { title: "Page not found" };

/** Unknown URLs. Payment-path URLs never land here: bad checkout links redirect to Plans. */
export default function NotFound() {
  return (
    <div className="shell shell-focus">
      <header className="topbar">
        <Wordmark />
      </header>
      <main className="focus-main" id="main">
        <ErrorState
          kind="neutral"
          title="We couldn't find that page"
          body="The link may be old or mistyped. Your plan and payments aren't affected."
        />
      </main>
    </div>
  );
}
