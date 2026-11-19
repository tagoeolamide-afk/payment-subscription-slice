import { NextResponse, type NextRequest } from "next/server";
import { FAULT_COOKIE, FAULT_POINTS, faultsEnabled, isFaultPoint } from "@/lib/dev-fault-points";

/**
 * Development only. Switches a test error on (?point=billing_page) and opens the page where
 * it shows, or switches it off (?clear=1) and goes back to Billing.
 * A route handler, not a page, so it still works when the layout itself is the thing failing.
 */
export function GET(request: NextRequest) {
  if (!faultsEnabled()) return NextResponse.json({ error: "Not available" }, { status: 403 });

  const url = request.nextUrl;
  if (url.searchParams.get("clear")) {
    const res = NextResponse.redirect(new URL("/billing", url));
    res.cookies.delete(FAULT_COOKIE);
    return res;
  }

  const point = url.searchParams.get("point");
  if (!isFaultPoint(point)) return NextResponse.redirect(new URL("/billing", url));
  const res = NextResponse.redirect(new URL(FAULT_POINTS[point].next, url));
  // Expires on its own after 10 minutes, in case it's forgotten.
  res.cookies.set(FAULT_COOKIE, point, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 600 });
  return res;
}
