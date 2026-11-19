import { redirect } from "next/navigation";

/** /checkout without a plan: send them to choose one rather than a 404. */
export default function CheckoutIndex() {
  redirect("/plans");
}
