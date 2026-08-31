import { useAuth } from "@/contexts/AuthContext";
import { Home, HeartHandshake, MessageCircle, UserRound } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Link, useLocation } from "wouter";

export function Brand() {
  return (
    <Link href="/" className="brand" aria-label="Plans home">
      <img src="/mark.svg" width="32" height="32" alt="" />
      <span>Plans</span>
    </Link>
  );
}

const navItems = [
  { href: "/", label: "Explore", icon: Home },
  { href: "/requests", label: "Who’s Down", icon: HeartHandshake },
  { href: "/chats", label: "Chats", icon: MessageCircle },
  { href: "/me", label: "Profile", icon: UserRound },
];

function navIsActive(location: string, href: string) {
  if (href === "/") return location === "/" || location.startsWith("/activity/") || location.startsWith("/profile/");
  if (href === "/chats") return location === "/chats" || location.startsWith("/chats/") || location.startsWith("/date/");
  return location === href;
}

export function AppShell({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  const { user } = useAuth();
  const [location] = useLocation();
  return (
    <div className={compact ? "app app--compact" : "app"}>
      <header className="topbar">
        <Brand />
        <nav className="desktop-nav" aria-label="Primary navigation">
          {navItems.map((item) => (
            <Link key={item.href} href={item.href} className={navIsActive(location, item.href) ? "active" : ""} aria-current={navIsActive(location, item.href) ? "page" : undefined}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="topbar__actions">
          <label className="city-select">
            <span className="sr-only">City</span>
            <select aria-label="City" defaultValue="Bangalore">
              <option>Bangalore</option>
            </select>
          </label>
          {user ? (
            <Link href="/me" className="nav-avatar" aria-label="Open your profile">
              {user.photos[0] ? <img src={user.photos[0].url} alt="" /> : <span>{user.name?.slice(0, 1) || "P"}</span>}
            </Link>
          ) : (
            <Link href={`/auth?returnTo=${encodeURIComponent(location)}`} className="button button--small">
              Log in
            </Link>
          )}
        </div>
      </header>
      <main>{children}</main>
      <nav className="mobile-nav" aria-label="Primary navigation">
        {navItems.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} className={navIsActive(location, href) ? "active" : ""} aria-current={navIsActive(location, href) ? "page" : undefined}>
            <Icon size={19} strokeWidth={1.8} />
            <span>{label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const [location, navigate] = useLocation();
  useEffect(() => {
    if (!loading && !user) navigate(`/auth?returnTo=${encodeURIComponent(location + window.location.search)}`, { replace: true });
    else if (!loading && user && !user.onboardingComplete && !location.startsWith("/onboarding")) {
      navigate(`/onboarding?returnTo=${encodeURIComponent(location + window.location.search)}`, { replace: true });
    }
  }, [loading, user, location, navigate]);
  if (loading || !user || (!user.onboardingComplete && !location.startsWith("/onboarding"))) return <PageLoader />;
  return <>{children}</>;
}

export function PageLoader() {
  return (
    <div className="page-loader" role="status">
      <span />
      Finding a good plan…
    </div>
  );
}

export function EmptyState({ title, copy, action }: { title: string; copy: string; action?: ReactNode }) {
  return (
    <section className="empty-state">
      <span className="eyebrow">Nothing here yet</span>
      <h1>{title}</h1>
      <p>{copy}</p>
      {action}
    </section>
  );
}
