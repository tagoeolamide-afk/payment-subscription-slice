import { redirect } from "next/navigation";

/** /checkout/return/<anything>: keep the query (tx_ref, status) and use the real return page. */
export default async function ReturnDeeper({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) for (const x of Array.isArray(v) ? v : v ? [v] : []) q.append(k, x);
  redirect(`/checkout/return${q.size ? `?${q}` : ""}`);
}
