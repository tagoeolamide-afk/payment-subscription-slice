import { getBillingState, isDemoResetEnabled } from "@/lib/billing";
import { activeFault, maybeFail } from "@/lib/dev-faults";
import { getCurrentUser } from "@/lib/store";
import { ResetFlowButton } from "./ResetFlowButton";
import { UserChip } from "./UserChip";
import { Wordmark } from "./Wordmark";

export async function TopBar() {
  await maybeFail("layout"); // development-only test error
  const devTools = isDemoResetEnabled();
  const fault = await activeFault();
  const state = devTools ? await getBillingState(getCurrentUser().id) : null;
  const canSkip = state?.status === "active" || state?.status === "cancelling" || state?.status === "renewal_due";

  return (
    <header className="topbar">
      <Wordmark />
      <div className="topbar-right">
        {devTools && <ResetFlowButton canSkip={canSkip} activeFault={fault} />}
        <UserChip />
      </div>
    </header>
  );
}
