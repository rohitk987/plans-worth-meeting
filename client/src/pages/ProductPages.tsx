import { AppShell, Brand, EmptyState, PageLoader } from "@/components/AppShell";
import { useAuth } from "@/contexts/AuthContext";
import { api, queryValue, safeReturnTo, uploadPhoto, type Activity, type PersonPreview, type PublicProfile, type User } from "@/lib/api";
import { ArrowLeft, ArrowRight, Check, Clock, MapPin, Send, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Link, useLocation } from "wouter";

const VIBES = ["Food", "Creative", "Events", "Outdoors", "Games", "Chill"];

function ErrorNotice({ message }: { message: string }) {
  return message ? <p className="error-notice" role="alert">{message}</p> : null;
}

function PeopleStack({ people = [], count }: { people?: { id: string; name: string; url: string }[]; count: number }) {
  return (
    <div className="people-stack" aria-label={`${count} people are down`}>
      <div>{people.slice(0, 4).map((person) => <img key={person.id} src={person.url} alt={person.name} loading="lazy" />)}</div>
      <span>{count} {count === 1 ? "person is" : "people are"} down</span>
    </div>
  );
}

function ActivityCard({ activity, featured = false }: { activity: Activity; featured?: boolean }) {
  return (
    <article className={`${featured ? "activity-card activity-card--featured" : "activity-card"} activity-card--${activity.id}`}>
      <Link href={`/activity/${activity.id}`} className="activity-card__image" aria-label={`Open ${activity.name}`}>
        <img src={activity.image_url} alt={`${activity.name} in ${activity.location}`} loading={featured ? "eager" : "lazy"} decoding="async" />
      </Link>
      <div className="activity-card__body">
        <div className="activity-meta"><span><MapPin size={14} />{activity.location}</span><span><Clock size={14} />{activity.date_label} · {activity.time_label}</span></div>
        <h3><Link href={`/activity/${activity.id}`}>{activity.name}</Link></h3>
        <p>{activity.description}</p>
        <div className="activity-card__footer">
          <PeopleStack people={activity.people} count={activity.interestedCount} />
          <Link className="circle-link" href={`/activity/${activity.id}`} aria-label={`See ${activity.name}`}><ArrowRight size={18} /></Link>
        </div>
      </div>
    </article>
  );
}

function PlanStrip({ activity }: { activity: Activity }) {
  return (
    <div className="plan-strip">
      <img src={activity.image_url} alt="" />
      <div><span>Your plan</span><strong>{activity.name}</strong><small>{activity.location} · {activity.date_label} · {activity.time_label}</small></div>
    </div>
  );
}

function PersonCard({ person, activityId, authenticated }: { person: PersonPreview; activityId: string; authenticated: boolean }) {
  const destination = `/profile/${person.id}?activity=${activityId}`;
  const href = authenticated ? destination : `/auth?returnTo=${encodeURIComponent(destination)}`;
  return (
    <article className="person-card">
      <Link href={href} className="person-card__photo" aria-label={`View ${person.name}'s profile`}>
        <img src={person.photo_url} alt={person.name} loading="lazy" decoding="async" />
      </Link>
      <div className="person-card__body">
        <h3><Link href={href}>{person.name}, {person.age}</Link></h3>
        <span>{person.city}</span>
        <div className="tag-row">{person.vibes.slice(0, 4).map((vibe) => <span key={vibe}>{vibe}</span>)}</div>
        <p>{person.bio}</p>
        <Link href={href} className="text-link">View profile <ArrowRight size={15} /></Link>
      </div>
    </article>
  );
}

export function ExplorePage() {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [vibe, setVibe] = useState("All");
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ activities: Activity[] }>("/api/activities").then((result) => setActivities(result.activities)).catch((err) => setError(err.message));
  }, []);
  const tonight = activities.find((activity) => activity.id === "church-street");
  const visible = vibe === "All" ? activities : activities.filter((activity) => activity.categories.includes(vibe));
  return (
    <AppShell>
      <div className="page-shell explore-page">
        <section className="explore-hero">
          <span className="eyebrow">Dating in Bangalore</span>
          <h1>Pick the plan.<br />Then pick <em>your person.</em></h1>
          <p>Start with something you’d actually do. See who else is down, choose someone you like, and make a date of it.</p>
          <a className="button" href="#plans">Find your plan <ArrowRight size={17} /></a>
        </section>
        <ErrorNotice message={error} />
        {!activities.length && !error ? <PageLoader /> : null}
        {tonight ? (
          <section className="section-block tonight-section">
            <div className="section-heading"><h2>Tonight’s Pick</h2><Link href={`/activity/${tonight.id}`}>See who’s down <ArrowRight size={16} /></Link></div>
            <ActivityCard activity={tonight} featured />
          </section>
        ) : null}
        <section className="section-block" id="plans">
          <div className="section-heading"><div><span className="eyebrow">Three plans. Your move.</span><h2>What feels like you?</h2></div></div>
          <div className="vibe-filter" aria-label="Filter plans by vibe">
            {["All", ...VIBES].map((item) => <button key={item} className={vibe === item ? "active" : ""} aria-pressed={vibe === item} onClick={() => setVibe(item)}>{item}</button>)}
          </div>
          <div className="activity-grid">
            {visible.map((activity) => <ActivityCard key={activity.id} activity={activity} />)}
          </div>
          {!visible.length ? <p className="filter-empty">No plan carries that vibe yet. Try another one.</p> : null}
        </section>
      </div>
      <footer className="site-footer"><span>Plans for people worth meeting.</span><a href="/photo-credits.html" target="_blank" rel="noreferrer">Photo credits</a></footer>
    </AppShell>
  );
}

export function ActivityPage({ id }: { id: string }) {
  const { user } = useAuth();
  const [activity, setActivity] = useState<Activity | null>(null);
  const [people, setPeople] = useState<PersonPreview[]>([]);
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);
  useEffect(() => {
    Promise.all([
      api<{ activity: Activity }>(`/api/activities/${id}`),
      api<{ people: PersonPreview[] }>(`/api/activities/${id}/people`),
    ]).then(([one, two]) => { setActivity(one.activity); setPeople(two.people); }).catch((err) => setError(err.message));
  }, [id]);
  async function joinPlan() {
    setJoining(true); setError("");
    try {
      await api(`/api/activities/${id}/interest`, { method: "POST" });
      setActivity((current) => current ? { ...current, viewerInterested: true } : current);
      toast.success("You’re down for this plan");
    } catch (err) { setError(err instanceof Error ? err.message : "Please try again."); }
    finally { setJoining(false); }
  }
  if (!activity && !error) return <AppShell><PageLoader /></AppShell>;
  if (!activity) return <AppShell><div className="page-shell"><ErrorNotice message={error} /></div></AppShell>;
  return (
    <AppShell>
      <div className="page-shell detail-page">
        <Link href="/" className="back-link"><ArrowLeft size={16} />Back to Explore</Link>
        <section className={`activity-hero activity-hero--${activity.id}`}>
          <div className="activity-hero__image"><img src={activity.image_url} alt={`${activity.name} in ${activity.location}`} /></div>
          <div className="activity-hero__copy">
            <span className="eyebrow">A plan worth meeting for</span>
            <h1>{activity.name}</h1>
            <p>{activity.description}</p>
            <div className="activity-facts"><span><MapPin size={17} />{activity.location}</span><span><Clock size={17} />{activity.date_label} · {activity.time_label}</span></div>
            <div className="activity-actions">
              <Link className="button" href={`/activity/${activity.id}/people`}>See all {activity.interestedCount} people <ArrowRight size={17} /></Link>
              {user?.onboardingComplete ? <button className="button button--secondary" onClick={joinPlan} disabled={joining || activity.viewerInterested}>{activity.viewerInterested ? "You’re down" : joining ? "Adding you…" : "I’m down for this"}</button> : <Link className="button button--secondary" href={user ? `/onboarding?returnTo=${encodeURIComponent(`/activity/${id}`)}` : `/auth?returnTo=${encodeURIComponent(`/activity/${id}`)}`}>I’m down for this</Link>}
            </div>
          </div>
        </section>
        <section className="section-block people-preview">
          <div className="section-heading"><div><span className="eyebrow">Who’s down</span><h2>Start with a face.</h2></div><Link href={`/activity/${activity.id}/people`}>See all {activity.interestedCount} <ArrowRight size={16} /></Link></div>
          <div className="people-grid people-grid--preview">{people.slice(0, 4).map((person) => <PersonCard key={person.id} person={person} activityId={activity.id} authenticated={Boolean(user)} />)}</div>
        </section>
      </div>
    </AppShell>
  );
}

export function PeoplePage({ id }: { id: string }) {
  const { user } = useAuth();
  const [activity, setActivity] = useState<Activity | null>(null);
  const [people, setPeople] = useState<PersonPreview[]>([]);
  const [vibe, setVibe] = useState("All");
  const [error, setError] = useState("");
  useEffect(() => {
    Promise.all([api<{ activity: Activity }>(`/api/activities/${id}`), api<{ people: PersonPreview[] }>(`/api/activities/${id}/people`)]).then(([one, two]) => { setActivity(one.activity); setPeople(two.people); }).catch((err) => setError(err.message));
  }, [id]);
  const visible = vibe === "All" ? people : people.filter((person) => person.vibes.includes(vibe));
  if (!activity && !error) return <AppShell><PageLoader /></AppShell>;
  if (!activity) return <AppShell><div className="page-shell"><ErrorNotice message={error} /></div></AppShell>;
  return (
    <AppShell>
      <div className="page-shell people-page">
        <Link href={`/activity/${id}`} className="back-link"><ArrowLeft size={16} />Back to plan</Link>
        <PlanStrip activity={activity} />
        <div className="page-heading"><span className="eyebrow">{people.length} people are down</span><h1>Who would you like to meet?</h1><p>Choose someone who feels interesting. They’ll decide if the plan feels mutual.</p></div>
        <div className="vibe-filter" aria-label="Filter people by vibe">{["All", ...VIBES].map((item) => <button key={item} className={vibe === item ? "active" : ""} aria-pressed={vibe === item} onClick={() => setVibe(item)}>{item}</button>)}</div>
        <div className="people-grid">{visible.map((person) => <PersonCard key={person.id} person={person} activityId={activity.id} authenticated={Boolean(user)} />)}</div>
        {!visible.length ? <p className="filter-empty">No one here has chosen that vibe yet.</p> : null}
      </div>
    </AppShell>
  );
}

export function ProfilePage({ id }: { id: string }) {
  const activityId = queryValue("activity");
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    Promise.all([
      api<{ profile: PublicProfile }>(`/api/profiles/${id}`),
      activityId ? api<{ activity: Activity }>(`/api/activities/${activityId}`) : Promise.resolve({ activity: null as Activity | null }),
    ]).then(([one, two]) => { setProfile(one.profile); setActivity(two.activity); }).catch((err) => setError(err.message));
  }, [id, activityId]);
  async function invite() {
    if (!activityId) return;
    setSending(true); setError("");
    try {
      await api("/api/invitations", { method: "POST", body: JSON.stringify({ receiverId: id, activityId }) });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Please try again.");
    } finally { setSending(false); }
  }
  if (!profile && !error) return <AppShell><PageLoader /></AppShell>;
  if (!profile) return <AppShell><div className="page-shell"><ErrorNotice message={error} /></div></AppShell>;
  return (
    <AppShell>
      <div className="page-shell profile-page">
        <Link href={activityId ? `/activity/${activityId}/people` : "/"} className="back-link"><ArrowLeft size={16} />Back to people</Link>
        <section className="profile-hero">
          <div className="profile-gallery">
            {profile.photos.map((photo, index) => <img key={photo.id} src={photo.url} alt={index === 0 ? profile.name : `${profile.name} photo ${index + 1}`} loading={index === 0 ? "eager" : "lazy"} decoding="async" />)}
          </div>
          <div className="profile-copy">
            <span className="eyebrow">Bangalore</span>
            <h1>{profile.name}, {profile.age}</h1>
            <div className="tag-row">{profile.vibes.map((vibe) => <span key={vibe}>{vibe}</span>)}</div>
            <blockquote>“{profile.bio}”</blockquote>
            <dl><div><dt>Looking for</dt><dd>{profile.intent}</dd></div><div><dt>Based in</dt><dd>{profile.city}</dd></div></dl>
            {activity ? <PlanStrip activity={activity} /> : null}
            <ErrorNotice message={error} />
            {sent ? (
              <div className="success-card" role="status"><Check size={20} /><div><strong>Invitation sent.</strong><span>{profile.name} can accept or pass. You’ll see the answer in Who’s Down.</span></div><Link href="/requests">View invitations</Link></div>
            ) : activity ? (
              <button className="button button--wide" onClick={invite} disabled={sending}>{sending ? "Sending…" : `Ask ${profile.name} to join you`}<ArrowRight size={17} /></button>
            ) : <Link className="button" href="/">Choose a plan first</Link>}
          </div>
        </section>
      </div>
    </AppShell>
  );
}

export function AuthPage() {
  const { user, loading, login, register, refresh } = useAuth();
  const [, navigate] = useLocation();
  const returnTo = safeReturnTo(queryValue("returnTo"));
  const closeTo = useMemo(() => {
    const requested = new URL(returnTo, window.location.origin);
    if (requested.pathname.startsWith("/profile/")) {
      const activity = requested.searchParams.get("activity");
      return activity ? `/activity/${encodeURIComponent(activity)}/people` : "/";
    }
    return requested.pathname === "/" || requested.pathname.startsWith("/activity/") ? `${requested.pathname}${requested.search}` : "/";
  }, [returnTo]);
  const [accountMode, setAccountMode] = useState<"login" | "register">("login");
  const [method, setMethod] = useState<"email" | "phone">("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("+91");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && user) navigate(user.onboardingComplete ? returnTo : `/onboarding?returnTo=${encodeURIComponent(returnTo)}`, { replace: true });
  }, [loading, user, navigate, returnTo]);

  async function submitEmail(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = accountMode === "login" ? await login(email, password) : await register(email, password);
      navigate(result.onboardingComplete ? returnTo : `/onboarding?returnTo=${encodeURIComponent(returnTo)}`);
    } catch (err) { setError(err instanceof Error ? err.message : "Please try again."); }
    finally { setBusy(false); }
  }
  async function requestCode() {
    setBusy(true); setError("");
    try {
      const result = await api<{ devCode: string }>("/api/auth/otp/request", { method: "POST", body: JSON.stringify({ phone, purpose: "login" }) });
      setDevCode(result.devCode);
    } catch (err) { setError(err instanceof Error ? err.message : "Please try again."); }
    finally { setBusy(false); }
  }
  async function verifyCode(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await api<{ user: User }>("/api/auth/otp/verify", { method: "POST", body: JSON.stringify({ phone, code, purpose: "login" }) });
      await refresh();
      navigate(result.user.onboardingComplete ? returnTo : `/onboarding?returnTo=${encodeURIComponent(returnTo)}`);
    } catch (err) { setError(err instanceof Error ? err.message : "Please try again."); }
    finally { setBusy(false); }
  }
  return (
    <div className="auth-page">
      <div className="auth-page__visual"><img src="/images/church.jpg" alt="Church Street at night" /><div><span className="eyebrow">Your plan is waiting</span><h1>Meet over something real.</h1><p>Come back to the person and plan you picked after signing in.</p></div></div>
      <section className="auth-panel">
        <Brand />
        <Link href={closeTo} className="auth-close" aria-label="Close sign in"><X size={20} /></Link>
        <div className="auth-card">
          <span className="eyebrow">{accountMode === "login" ? "Welcome back" : "Make your profile"}</span>
          <h2>{accountMode === "login" ? "Log in to keep going." : "Create an account."}</h2>
          <p>{accountMode === "login" ? "Your picks, matches, and chats will be right where you left them." : "You’ll return to this exact plan after a quick setup."}</p>
          <div className="auth-methods"><button className={method === "email" ? "active" : ""} aria-pressed={method === "email"} onClick={() => setMethod("email")}>Email</button><button className={method === "phone" ? "active" : ""} aria-pressed={method === "phone"} onClick={() => setMethod("phone")}>Phone</button></div>
          {method === "email" ? (
            <form onSubmit={submitEmail} className="form-stack">
              <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required placeholder="you@example.com" /></label>
              <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={accountMode === "login" ? "current-password" : "new-password"} minLength={8} required placeholder="At least 8 characters" /></label>
              <ErrorNotice message={error} />
              <button className="button button--wide" disabled={busy}>{busy ? "One moment…" : accountMode === "login" ? "Log in" : "Create account"}<ArrowRight size={17} /></button>
            </form>
          ) : (
            <form onSubmit={verifyCode} className="form-stack">
              <label>Indian mobile number<input type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+91 98765 43210" /></label>
              {devCode ? <div className="dev-code"><strong>Development sign-in</strong><span>No SMS was sent. Use code <b>{devCode}</b>.</span></div> : null}
              {devCode ? <label>Six-digit code<input inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="246810" /></label> : null}
              <ErrorNotice message={error} />
              {devCode ? <button className="button button--wide" disabled={busy || code.length !== 6}>Verify and continue</button> : <button type="button" className="button button--wide" onClick={requestCode} disabled={busy}>{import.meta.env.DEV ? "Generate development code" : "Send OTP"}</button>}
            </form>
          )}
          <div className="auth-divider"><span />or<span /></div>
          <button className="button button--secondary button--wide" disabled aria-describedby="google-status">Continue with Google</button>
          <small id="google-status">Google sign-in is not configured in this build.</small>
          <button className="auth-switch" onClick={() => { setAccountMode(accountMode === "login" ? "register" : "login"); setError(""); }}>{accountMode === "login" ? "New here? Create an account" : "Already have an account? Log in"}</button>
          <small>By continuing, you agree to treat people with respect and keep every meetup consensual.</small>
        </div>
      </section>
    </div>
  );
}

type Basics = { name: string; age: string; gender: string; preferences: string[]; intent: string; bio: string };

export function OnboardingPage() {
  const { user, loading, refresh, logout } = useAuth();
  const [, navigate] = useLocation();
  const returnTo = safeReturnTo(queryValue("returnTo"));
  const initialStep = user?.name ? user.photos.length < 2 ? 2 : user.vibes.length < 2 ? 3 : 4 : 1;
  const [step, setStep] = useState(initialStep);
  const [basics, setBasics] = useState<Basics>({ name: user?.name || "", age: user?.age ? String(user.age) : "", gender: user?.gender || "", preferences: user?.preferences || [], intent: user?.intent || "", bio: user?.bio || "" });
  const [vibes, setVibes] = useState<string[]>(user?.vibes || []);
  const [pendingPhotos, setPendingPhotos] = useState<{ name: string; url: string }[]>([]);
  const [phone, setPhone] = useState(user?.phone || "+91");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loading && !user) navigate(`/auth?returnTo=${encodeURIComponent(`/onboarding?returnTo=${encodeURIComponent(returnTo)}`)}`, { replace: true });
  }, [loading, user, navigate, returnTo]);
  useEffect(() => {
    if (!user) return;
    setBasics({ name: user.name, age: user.age ? String(user.age) : "", gender: user.gender, preferences: user.preferences, intent: user.intent, bio: user.bio });
    setVibes(user.vibes);
    setPhone(user.phone || "+91");
  }, [user?.id]);

  if (loading || !user) return <PageLoader />;

  const payload = { ...basics, age: Number(basics.age), vibes };
  async function saveBasics(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await api("/api/me", { method: "PATCH", body: JSON.stringify(payload) }); await refresh(); setStep(2); }
    catch (err) { setError(err instanceof Error ? err.message : "Please try again."); }
    finally { setBusy(false); }
  }
  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    const selected = Array.from(files);
    const invalid = selected.find((file) => !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024);
    if (invalid) return setError("Choose JPG, PNG, or WebP photos under 5 MB.");
    if ((user?.photos.length || 0) + selected.length > 4) return setError("You can add up to four photos.");
    const previews = selected.map((file) => ({ name: file.name, url: URL.createObjectURL(file) }));
    setPendingPhotos(previews); setBusy(true); setError("");
    try { for (const file of selected) await uploadPhoto(file); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : "A photo could not be uploaded."); }
    finally { previews.forEach((preview) => URL.revokeObjectURL(preview.url)); setPendingPhotos([]); setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }
  async function replacePhoto(id: string, file: File | undefined) {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) return setError("Choose a JPG, PNG, or WebP photo under 5 MB.");
    setBusy(true); setError("");
    try { await uploadPhoto(file, id); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : "That photo could not be replaced."); }
    finally { setBusy(false); }
  }
  async function removePhoto(id: string) {
    setBusy(true); setError("");
    try { await api(`/api/me/photos/${id}`, { method: "DELETE" }); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : "That photo could not be removed."); }
    finally { setBusy(false); }
  }
  async function saveVibes() {
    if (vibes.length < 2) return setError("Choose at least two vibes.");
    setBusy(true); setError("");
    try { await api("/api/me", { method: "PATCH", body: JSON.stringify({ ...payload, vibes }) }); await refresh(); setStep(4); }
    catch (err) { setError(err instanceof Error ? err.message : "Please try again."); }
    finally { setBusy(false); }
  }
  async function requestSafetyCode() {
    setBusy(true); setError("");
    try { const result = await api<{ devCode: string }>("/api/auth/otp/request", { method: "POST", body: JSON.stringify({ phone, purpose: "safety" }) }); setDevCode(result.devCode); }
    catch (err) { setError(err instanceof Error ? err.message : "Please try again."); }
    finally { setBusy(false); }
  }
  async function verifySafetyCode() {
    setBusy(true); setError("");
    try { await api("/api/auth/otp/verify", { method: "POST", body: JSON.stringify({ phone, code, purpose: "safety" }) }); await refresh(); toast.success("Phone verified"); }
    catch (err) { setError(err instanceof Error ? err.message : "Please try again."); }
    finally { setBusy(false); }
  }
  async function finish() {
    setBusy(true); setError("");
    try { await api("/api/me/complete", { method: "POST" }); await refresh(); navigate(returnTo); }
    catch (err) { setError(err instanceof Error ? err.message : "Please try again."); }
    finally { setBusy(false); }
  }
  async function signOut() {
    await logout();
    navigate("/");
  }

  return (
    <div className="onboarding-page">
      <header><Brand /><div className="progress" role="progressbar" aria-label="Profile setup" aria-valuemin={1} aria-valuemax={4} aria-valuenow={step}><span style={{ width: `${step * 25}%` }} /></div><div className="onboarding-header-actions"><button onClick={signOut}>Log out</button><button onClick={() => navigate(returnTo)} aria-label="Close setup"><X size={20} /></button></div></header>
      <main className="onboarding-layout">
        <aside><span className="eyebrow">Step {step} of 4</span><h1>{step === 1 ? "Start with the real you." : step === 2 ? "Add photos that feel like you." : step === 3 ? "What are you usually down for?" : "One last safety check."}</h1><p>{step === 1 ? "Just enough for someone to know whether they’d enjoy the plan with you." : step === 2 ? "Use two to four clear, recent photos. You can remove or replace them anytime." : step === 3 ? "Choose two to four. Keep it simple; this isn’t a résumé." : "Verify an Indian mobile number before your profile goes live."}</p></aside>
        <section className="onboarding-card">
          {step === 1 ? (
            <form onSubmit={saveBasics} className="form-stack form-grid">
              <label className="full">First name<input value={basics.name} onChange={(event) => setBasics({ ...basics, name: event.target.value })} required maxLength={60} placeholder="Aanya" /></label>
              <label>Age<input type="number" min="18" max="80" value={basics.age} onChange={(event) => setBasics({ ...basics, age: event.target.value })} required placeholder="26" /></label>
              <label>Gender<select value={basics.gender} onChange={(event) => setBasics({ ...basics, gender: event.target.value })} required><option value="">Choose</option><option>Woman</option><option>Man</option><option>Non-binary</option><option>Prefer to self-describe</option></select></label>
              <fieldset className="full"><legend>Interested in</legend><div className="choice-row">{["Women", "Men", "Non-binary people", "Everyone"].map((choice) => <button type="button" key={choice} className={basics.preferences.includes(choice) ? "selected" : ""} aria-pressed={basics.preferences.includes(choice)} onClick={() => setBasics({ ...basics, preferences: basics.preferences.includes(choice) ? basics.preferences.filter((item) => item !== choice) : [...basics.preferences, choice] })}>{choice}</button>)}</div></fieldset>
              <label className="full">What are you looking for?<select value={basics.intent} onChange={(event) => setBasics({ ...basics, intent: event.target.value })} required><option value="">Choose</option><option>A relationship</option><option>Open to seeing where it goes</option><option>Something casual</option><option>New people and good plans</option></select></label>
              <label className="full">One human line<textarea value={basics.bio} onChange={(event) => setBasics({ ...basics, bio: event.target.value })} maxLength={180} placeholder="Usually down for food after 8." /></label>
              <ErrorNotice message={error} /><button className="button full" disabled={busy}>Save and add photos <ArrowRight size={17} /></button>
            </form>
          ) : null}
          {step === 2 ? (
            <div>
              <div className="photo-grid">
                {user.photos.map((photo, index) => <div className="photo-slot" key={photo.id}><img src={photo.url} alt={`Profile photo ${index + 1}`} /><button onClick={() => removePhoto(photo.id)} disabled={busy} aria-label={`Remove photo ${index + 1}`}><X size={15} /></button><label>Replace<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => replacePhoto(photo.id, event.target.files?.[0])} /></label></div>)}
                {pendingPhotos.map((photo) => <div className="photo-slot photo-slot--pending" key={photo.url}><img src={photo.url} alt={`Uploading ${photo.name}`} /><span>Uploading…</span></div>)}
                {user.photos.length + pendingPhotos.length < 4 ? <button className="photo-add" onClick={() => fileRef.current?.click()} disabled={busy}><span>+</span>Add photos</button> : null}
              </div>
              <input ref={fileRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => addFiles(event.target.files)} />
              <p className="field-note">JPG, PNG, or WebP · up to 5 MB each · {user.photos.length}/4 added</p>
              <ErrorNotice message={error} />
              <div className="step-actions"><button className="button button--secondary" onClick={() => setStep(1)}>Back</button><button className="button" onClick={() => setStep(3)} disabled={user.photos.length < 2 || busy}>Choose my vibes <ArrowRight size={17} /></button></div>
            </div>
          ) : null}
          {step === 3 ? (
            <div>
              <div className="vibe-picker">{VIBES.map((vibe) => <button key={vibe} className={vibes.includes(vibe) ? "selected" : ""} aria-pressed={vibes.includes(vibe)} onClick={() => setVibes(vibes.includes(vibe) ? vibes.filter((item) => item !== vibe) : vibes.length < 4 ? [...vibes, vibe] : vibes)}>{vibe}{vibes.includes(vibe) ? <Check size={17} /> : null}</button>)}</div>
              <p className="field-note">Choose {Math.max(0, 2 - vibes.length)} more · maximum four</p><ErrorNotice message={error} />
              <div className="step-actions"><button className="button button--secondary" onClick={() => setStep(2)}>Back</button><button className="button" onClick={saveVibes} disabled={vibes.length < 2 || busy}>Safety check <ArrowRight size={17} /></button></div>
            </div>
          ) : null}
          {step === 4 ? (
            <div className="verify-card">
              {user.verificationStatus === "verified" ? <div className="verified"><Check size={24} /><div><strong>Phone verified</strong><span>{user.phone}</span></div></div> : <>
                <label>Indian mobile number<input type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+91 98765 43210" /></label>
                {devCode ? <div className="dev-code"><strong>Development verification</strong><span>No SMS was sent. Use code <b>{devCode}</b>.</span></div> : null}
                {devCode ? <label>Six-digit code<input inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="246810" /></label> : null}
                {devCode ? <button className="button button--wide" onClick={verifySafetyCode} disabled={busy || code.length !== 6}>Verify phone</button> : <button className="button button--wide" onClick={requestSafetyCode} disabled={busy}>{import.meta.env.DEV ? "Generate development code" : "Send OTP"}</button>}
              </>}
              <ErrorNotice message={error} />
              <div className="step-actions"><button className="button button--secondary" onClick={() => setStep(3)}>Back</button><button className="button" onClick={finish} disabled={user.verificationStatus !== "verified" || busy}>Finish profile <ArrowRight size={17} /></button></div>
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}

type Invitation = { id: string; name: string; age: number; photo_url: string; activity_name: string; location: string; status: string; created_at: string };

export function RequestsPage() {
  const { eventVersion } = useAuth();
  const [incoming, setIncoming] = useState<Invitation[]>([]);
  const [outgoing, setOutgoing] = useState<Invitation[]>([]);
  const [opened, setOpened] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const load = () => api<{ incoming: Invitation[]; outgoing: Invitation[] }>("/api/invitations").then((result) => { setIncoming(result.incoming); setOutgoing(result.outgoing); }).catch((err) => setError(err.message));
  useEffect(() => { load(); }, [eventVersion]);
  async function respond(id: string, action: "accept" | "reject") {
    setError("");
    try {
      const result = await api<{ conversationId: string | null }>(`/api/invitations/${id}/respond`, { method: "POST", body: JSON.stringify({ action }) });
      if (result.conversationId) setOpened((value) => ({ ...value, [id]: result.conversationId! }));
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : "Please try again."); }
  }
  return (
    <AppShell><div className="page-shell list-page"><div className="page-heading"><span className="eyebrow">Mutual starts here</span><h1>Who’s Down</h1><p>Invitations are tied to a real plan. Accept one to create a match and an empty, private chat.</p></div><ErrorNotice message={error} />
      <section className="list-section"><h2>Invitations for you</h2>{!incoming.length ? <p className="quiet">No invitations yet. When someone picks you for a plan, it’ll appear here.</p> : <div className="invitation-list">{incoming.map((item) => <InvitationRow key={item.id} item={item}>{opened[item.id] ? <Link className="button button--small" href={`/chats/${opened[item.id]}`}>Open chat</Link> : item.status === "pending" ? <><button className="button button--secondary button--small" onClick={() => respond(item.id, "reject")}>Pass</button><button className="button button--small" onClick={() => respond(item.id, "accept")}>Accept</button></> : <span className={`status status--${item.status}`}>{item.status}</span>}</InvitationRow>)}</div>}</section>
      <section className="list-section"><h2>Sent by you</h2>{!outgoing.length ? <p className="quiet">You haven’t invited anyone yet.</p> : <div className="invitation-list">{outgoing.map((item) => <InvitationRow key={item.id} item={item}><span className={`status status--${item.status}`}>{item.status}</span></InvitationRow>)}</div>}</section>
    </div></AppShell>
  );
}

function InvitationRow({ item, children }: { item: Invitation; children: ReactNode }) {
  return <article className="invitation-row"><img src={item.photo_url} alt={item.name} /><div><strong>{item.name}, {item.age}</strong><span>{item.activity_name} · {item.location}</span></div><div className="invitation-row__actions">{children}</div></article>;
}

type ConversationSummary = { id: string; match_id: string; other_name: string; other_age: number; other_photo: string; activity_name: string; location: string; last_message: string | null; last_message_at: string | null };

export function ChatsPage() {
  const { eventVersion } = useAuth();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { api<{ conversations: ConversationSummary[] }>("/api/conversations").then((result) => setConversations(result.conversations)).finally(() => setLoaded(true)); }, [eventVersion]);
  if (!loaded) return <AppShell><PageLoader /></AppShell>;
  return (
    <AppShell><div className="page-shell list-page"><div className="page-heading"><span className="eyebrow">Matched over a plan</span><h1>Chats</h1><p>Every conversation here began with mutual interest.</p></div>
      {!conversations.length ? <EmptyState title="No matches yet." copy="Choose a plan and someone you’d like to meet. A chat opens only when they accept." action={<Link className="button" href="/">Explore plans</Link>} /> : <div className="conversation-list">{conversations.map((item) => <Link href={`/chats/${item.id}`} className="conversation-row" key={item.id}><img src={item.other_photo} alt={item.other_name} /><div><strong>{item.other_name}, {item.other_age}</strong><span>{item.activity_name} · {item.location}</span><p>{item.last_message || "You matched. Say hello when you’re ready."}</p></div><ArrowRight size={18} /></Link>)}</div>}
    </div></AppShell>
  );
}

type ConversationDetail = { id: string; match_id: string; activity_name: string; location: string; image_url: string; date_label: string; time_label: string; other_name: string; other_age: number; other_photo: string };
type Message = { id: string; sender_id: string; content: string; created_at: string };

export function ChatPage({ id }: { id: string }) {
  const { user, realtimeEvent } = useAuth();
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [datePlan, setDatePlan] = useState<unknown>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const load = () => api<{ conversation: ConversationDetail; messages: Message[]; datePlan: unknown }>(`/api/conversations/${id}`).then((result) => { setConversation(result.conversation); setMessages(result.messages); setDatePlan(result.datePlan); }).catch((err) => setError(err.message));
  useEffect(() => { load(); }, [id]);
  useEffect(() => {
    if (!realtimeEvent) return;
    if (realtimeEvent.type === "message" && realtimeEvent.data.conversationId === id && realtimeEvent.data.message) {
      const message = realtimeEvent.data.message as Message;
      setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]);
    } else if (realtimeEvent.type === "date-plan" && conversation && realtimeEvent.data.matchId === conversation.match_id) {
      load();
    } else if (realtimeEvent.type === "ready" && realtimeEvent.serial > 1) {
      load();
    }
  }, [realtimeEvent, id, conversation?.match_id]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length]);
  async function send(event: FormEvent) {
    event.preventDefault();
    const content = text.trim();
    if (!content) return;
    setText(""); setError("");
    try {
      const result = await api<{ message: Message }>(`/api/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ content, clientNonce: crypto.randomUUID() }) });
      setMessages((current) => current.some((item) => item.id === result.message.id) ? current : [...current, result.message]);
    }
    catch (err) { setText(content); setError(err instanceof Error ? err.message : "Message not sent."); }
  }
  if (!conversation && !error) return <AppShell compact><PageLoader /></AppShell>;
  if (!conversation) return <AppShell compact><div className="page-shell"><ErrorNotice message={error} /></div></AppShell>;
  return (
    <AppShell compact><div className="chat-layout"><header className="chat-header"><Link href="/chats" aria-label="Back to chats"><ArrowLeft size={19} /></Link><img src={conversation.other_photo} alt={conversation.other_name} /><div><strong>{conversation.other_name}, {conversation.other_age}</strong><span>{conversation.activity_name}</span></div><Link className="button button--small" href={`/date/${id}`}>{datePlan ? "View date" : "Make it official"}</Link></header>
      <div className="chat-plan"><img src={conversation.image_url} alt="" /><span>You matched over</span><strong>{conversation.activity_name}</strong><small>{conversation.location} · {conversation.date_label} · {conversation.time_label}</small></div>
      <div className="message-list">{!messages.length ? <div className="chat-empty"><strong>Your chat starts here.</strong><span>No scripted openers. Say what you actually want to say.</span></div> : messages.map((message) => <div key={message.id} className={message.sender_id === user?.id ? "message message--mine" : "message"}><p>{message.content}</p><time>{new Date(message.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></div>)}<div ref={endRef} /></div>
      <form className="composer" onSubmit={send}><label className="sr-only" htmlFor="message">Message {conversation.other_name}</label><input id="message" value={text} onChange={(event) => setText(event.target.value)} placeholder={`Message ${conversation.other_name}`} maxLength={1000} autoComplete="off" /><button aria-label="Send message" disabled={!text.trim()}><Send size={18} /></button></form><ErrorNotice message={error} />
    </div></AppShell>
  );
}

export function DatePage({ conversationId }: { conversationId: string }) {
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [datePlan, setDatePlan] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ conversation: ConversationDetail; datePlan: Record<string, string> | null }>(`/api/conversations/${conversationId}`).then((result) => { setConversation(result.conversation); setDatePlan(result.datePlan); }).catch((err) => setError(err.message)); }, [conversationId]);
  async function confirm() {
    if (!conversation) return;
    setBusy(true); setError("");
    try { const result = await api<{ datePlan: Record<string, string> }>(`/api/matches/${conversation.match_id}/date`, { method: "POST" }); setDatePlan(result.datePlan); }
    catch (err) { setError(err instanceof Error ? err.message : "Please try again."); }
    finally { setBusy(false); }
  }
  if (!conversation && !error) return <AppShell><PageLoader /></AppShell>;
  if (!conversation) return <AppShell><div className="page-shell"><ErrorNotice message={error} /></div></AppShell>;
  return (
    <AppShell><div className="date-page"><div className="date-page__image"><img src={conversation.image_url} alt={`${conversation.activity_name} in ${conversation.location}`} /></div><section className="date-card"><Link href={`/chats/${conversationId}`} className="back-link"><ArrowLeft size={16} />Back to chat</Link><span className="eyebrow">{datePlan ? "It’s official" : "Make it official"}</span><h1>{datePlan ? "You’re going." : "Turn the match into a date."}</h1><p className="date-pair">You and {conversation.other_name}</p><dl className="date-details"><div><dt>Activity</dt><dd>{conversation.activity_name}</dd></div><div><dt>Date</dt><dd>{conversation.date_label}</dd></div><div><dt>Time</dt><dd>{conversation.time_label}</dd></div><div><dt>Location</dt><dd>{conversation.location}</dd></div></dl><ErrorNotice message={error} />{datePlan ? <div className="success-line" role="status"><Check size={20} />Saved for both of you.</div> : <button className="button button--wide" onClick={confirm} disabled={busy}>{busy ? "Saving…" : "Confirm this date"}<ArrowRight size={17} /></button>}</section></div></AppShell>
  );
}

export function MyProfilePage() {
  const { user, logout } = useAuth();
  const [, navigate] = useLocation();
  if (!user) return <PageLoader />;
  async function signOut() { await logout(); navigate("/"); }
  return (
    <AppShell><div className="page-shell my-profile"><div className="profile-gallery">{user.photos.map((photo, index) => <img key={photo.id} src={photo.url} alt={`Profile photo ${index + 1}`} loading={index === 0 ? "eager" : "lazy"} decoding="async" />)}</div><section><span className="eyebrow">Your profile</span><h1>{user.name}, {user.age}</h1><p>{user.bio}</p><div className="tag-row">{user.vibes.map((vibe) => <span key={vibe}>{vibe}</span>)}</div><dl><div><dt>City</dt><dd>{user.city}</dd></div><div><dt>Looking for</dt><dd>{user.intent}</dd></div><div><dt>Phone</dt><dd>{user.verificationStatus === "verified" ? "Verified" : "Not verified"}</dd></div></dl><div className="profile-actions"><Link className="button" href="/requests">View invitations</Link><button className="button button--secondary" onClick={signOut}>Log out</button></div></section></div></AppShell>
  );
}

export function NotFoundPage() {
  return <AppShell><div className="page-shell"><EmptyState title="That page wandered off." copy="The plan may have moved, but Bangalore still has three good options." action={<Link className="button" href="/">Back to Explore</Link>} /></div></AppShell>;
}
