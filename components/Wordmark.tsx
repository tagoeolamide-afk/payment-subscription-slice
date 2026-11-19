import Link from "next/link";
import { PRODUCT_NAME } from "@/lib/plans";

export function Wordmark({ href = "/billing" }: { href?: string }) {
  return (
    <Link href={href} className="wordmark" aria-label={`${PRODUCT_NAME} home`}>
      <svg className="wordmark-mark" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M4 2.5h8.5L16 6v11.5H4z" fill="currentColor" />
        <path d="M12.5 2.5V6H16" fill="none" stroke="var(--paper)" strokeWidth="1.25" />
        <path d="M7 10h6M7 13h4" stroke="var(--paper)" strokeWidth="1.25" strokeLinecap="round" />
      </svg>
      <span>{PRODUCT_NAME}</span>
    </Link>
  );
}
