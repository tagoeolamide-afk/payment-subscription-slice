import "server-only";
import { cookies } from "next/headers";
import { FAULT_COOKIE, FAULT_POINTS, faultsEnabled, isFaultPoint, type FaultPoint } from "./dev-fault-points";

/** Which test error is switched on (development only), or null. */
export async function activeFault(): Promise<FaultPoint | null> {
  if (!faultsEnabled()) return null;
  const value = (await cookies()).get(FAULT_COOKIE)?.value;
  return isFaultPoint(value) ? value : null;
}

/** Throws a test error at `point` if Test tools switched it on. Does nothing in production. */
export async function maybeFail(point: FaultPoint): Promise<void> {
  if ((await activeFault()) === point) {
    throw new Error(`Test error at "${FAULT_POINTS[point].label}" (switched on in Test tools)`);
  }
}
