import { type FormEvent, useState } from "react";
import { type Permission, type Profile, type Share, supabase } from "./supabase";

export function SharePanel({ noteId, author, shares, isOwner, userId, onChange }: {
  noteId: string;
  author: Profile | null;
  shares: Share[];
  isOwner: boolean;
  userId: string;
  onChange: () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [permission, setPermission] = useState<Permission>("read");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function share(target: string, level: Permission) {
    setBusy(true);
    setError(null);
    const { error } = await supabase.functions.invoke("share-note", {
      body: { note_id: noteId, email: target, permission: level },
    });
    setBusy(false);
    if (error) {
      const body = await (error.context as Response | undefined)?.json?.().catch(() => null);
      setError(body?.error ?? error.message);
      return false;
    }
    await onChange();
    return true;
  }

  async function unshare(user: string) {
    const { error } = await supabase.from("note_shares").delete().eq("note_id", noteId).eq("user_id", user);
    if (error) return setError(error.message);
    await onChange();
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (await share(email.trim(), permission)) setEmail("");
  }

  const label = (profile: Profile | null) =>
    profile ? `${profile.display_name}${profile.id === userId ? " (you)" : ""}` : "Unknown user";

  return (
    <section className="sharing">
      <h2>Sharing</h2>
      <ul className="people">
        <li>
          <span>
            <strong>{label(author)}</strong>
            <span className="muted small">{author?.email}</span>
          </span>
          <span className="muted small">Author</span>
        </li>
        {shares.map((s) => (
          <li key={s.user_id}>
            <span>
              <strong>{label(s.profile)}</strong>
              <span className="muted small">{s.profile?.email}</span>
            </span>
            {isOwner && s.profile ? (
              <span className="row">
                <select
                  value={s.permission}
                  disabled={busy}
                  onChange={(e) => share(s.profile!.email, e.target.value as Permission)}
                >
                  <option value="read">Can read</option>
                  <option value="edit">Can edit</option>
                </select>
                <button className="link danger-link" onClick={() => unshare(s.user_id)}>Remove</button>
              </span>
            ) : (
              <span className="muted small">{s.permission === "edit" ? "Can edit" : "Can read"}</span>
            )}
          </li>
        ))}
      </ul>
      {shares.length === 0 && <p className="muted small">Only the author can see this note.</p>}
      {isOwner && (
        <form className="share-form" onSubmit={submit}>
          <input
            type="email"
            placeholder="Teammate's email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <select value={permission} onChange={(e) => setPermission(e.target.value as Permission)}>
            <option value="read">Can read</option>
            <option value="edit">Can edit</option>
          </select>
          <button type="submit" className="primary" disabled={busy}>Share</button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
