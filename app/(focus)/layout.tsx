import { TopBar } from "@/components/TopBar";

/** Checkout and its return page drop the settings nav so the payment is the only thing on screen. */
export default function FocusLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell shell-focus">
      <TopBar />
      <main className="focus-main" id="main">
        {children}
      </main>
    </div>
  );
}
