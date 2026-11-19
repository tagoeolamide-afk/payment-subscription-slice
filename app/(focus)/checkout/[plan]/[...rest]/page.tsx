import { redirect } from "next/navigation";

/** Anything deeper than /checkout/<plan> goes back to that plan's checkout (which handles unknown plans). */
export default async function CheckoutDeeper({ params }: { params: Promise<{ plan: string }> }) {
  const { plan } = await params;
  redirect(`/checkout/${encodeURIComponent(plan)}`);
}
