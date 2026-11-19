"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/billing", label: "Billing" },
  { href: "/plans", label: "Plans" },
];

export function SideNav() {
  const pathname = usePathname();
  return (
    <nav className="sidenav" aria-label="Settings">
      <p className="sidenav-label">Settings</p>
      <ul>
        {ITEMS.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Link href={item.href} className="sidenav-link" aria-current={active ? "page" : undefined}>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
