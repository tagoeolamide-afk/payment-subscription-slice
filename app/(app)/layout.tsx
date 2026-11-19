import { SideNav } from "@/components/SideNav";
import { TopBar } from "@/components/TopBar";

/** The signed-in shell: quiet top bar, settings nav, content column. */
export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <TopBar />
      <div className="shell-body">
        <SideNav />
        <main className="content" id="main">
          {children}
        </main>
      </div>
    </div>
  );
}
