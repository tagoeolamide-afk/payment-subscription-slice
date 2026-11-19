import { getCurrentUser } from "@/lib/store";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

export function UserChip() {
  const user = getCurrentUser();
  return (
    <div className="user-chip">
      <span className="avatar" aria-hidden="true">
        {initials(user.name)}
      </span>
      <span className="user-chip-text">
        <span className="user-chip-name">{user.name}</span>
        <span className="user-chip-email">{user.email}</span>
      </span>
    </div>
  );
}
