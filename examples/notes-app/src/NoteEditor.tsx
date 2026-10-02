import { useCallback, useEffect, useState } from "react";
import { Markdown } from "./Markdown";
import { go } from "./route";
import { SharePanel } from "./SharePanel";
import { formatDate, type Note, PROFILE, type Profile, type Role, supabase, type Tab } from "./supabase";

const NOTE = `id, author_id, title, content, updated_at,
  author:profiles!notes_author_id_fkey(${PROFILE}),
  editor:profiles!notes_updated_by_fkey(${PROFILE}),
  note_shares(user_id, permission, profile:profiles(${PROFILE}))`;

const ROLE_LABEL: Record<Role, string> = { owner: "Author", edit: "Can edit", read: "Read only" };

export function NoteEditor({ noteId, tab, userId, onChange }: {
  noteId: string;
  tab: Tab;
  userId: string;
  onChange: () => void;
}) {
  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [preview, setPreview] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("notes").select(NOTE).eq("id", noteId).returns<Note[]>().maybeSingle();
    if (error) return setError(error.message);
    if (!data) return setError("This note does not exist or is not shared with you.");
    setNote(data);
    setTitle(data.title);
    setContent(data.content);
  }, [noteId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!note) return <div className="empty">{error ? <p className="error">{error}</p> : null}</div>;

  const role: Role = note.author_id === userId
    ? "owner"
    : note.note_shares.find((share) => share.user_id === userId)?.permission ?? "read";
  const canEdit = role !== "read";
  const dirty = title !== note.title || content !== note.content;
  const name = (profile: Profile | null) => (profile?.id === userId ? "you" : profile?.display_name ?? "someone");

  async function save() {
    setStatus("Saving…");
    setError(null);
    const { data, error } = await supabase.from("notes").update({ title, content }).eq("id", noteId).select("id");
    if (error || !data.length) {
      setStatus(null);
      return setError(error?.message ?? "You are not allowed to edit this note.");
    }
    setStatus("Saved");
    await load();
    onChange();
  }

  async function remove() {
    if (!window.confirm(`Delete "${note!.title || "Untitled"}"? This cannot be undone.`)) return;
    const { error } = await supabase.from("notes").delete().eq("id", noteId);
    if (error) return setError(error.message);
    onChange();
    go("mine");
  }

  return (
    <article
      className="editor"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "s" && canEdit) {
          e.preventDefault();
          if (dirty) save();
        }
      }}
    >
      <header className="editor-header">
        <a href={`#/${tab}`} className="back">← {tab === "mine" ? "My notes" : "Shared with me"}</a>
        <span className={`badge role-${role}`}>{ROLE_LABEL[role]}</span>
        {canEdit && (
          <div className="segmented">
            <button className={preview ? undefined : "active"} onClick={() => setPreview(false)}>Write</button>
            <button className={preview ? "active" : undefined} onClick={() => setPreview(true)}>Preview</button>
          </div>
        )}
      </header>

      {canEdit && !preview ? (
        <>
          <input
            className="title-input"
            value={title}
            maxLength={200}
            placeholder="Title"
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="content-input"
            value={content}
            placeholder="Write in plain text or light markdown: # heading, - list, **bold**, *italic*, `code`"
            onChange={(e) => setContent(e.target.value)}
          />
        </>
      ) : (
        <>
          <h1 className="title">{title || "Untitled"}</h1>
          <Markdown source={content} />
        </>
      )}

      <footer className="editor-footer">
        <p className="muted small">
          By {name(note.author)} · last edited {formatDate(note.updated_at)}
          {note.editor && ` by ${name(note.editor)}`}
        </p>
        <div className="actions">
          {status && !dirty && <span className="muted small">{status}</span>}
          {role === "owner" && <button className="danger" onClick={remove}>Delete</button>}
          {canEdit && <button className="primary" onClick={save} disabled={!dirty}>Save</button>}
        </div>
      </footer>
      {error && <p className="error">{error}</p>}

      <SharePanel
        noteId={note.id}
        author={note.author}
        shares={note.note_shares}
        isOwner={role === "owner"}
        userId={userId}
        onChange={async () => {
          await load();
          onChange();
        }}
      />
    </article>
  );
}
