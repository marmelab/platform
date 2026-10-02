import { useEffect, useState } from "react";
import { go } from "./route";
import { formatDate, PROFILE, type Permission, type Profile, supabase, type Tab } from "./supabase";

interface Item {
  id: string;
  title: string;
  content: string;
  updated_at: string;
  detail: string;
  badge?: string;
  permission?: Permission;
}

interface MyNoteRow {
  id: string;
  title: string;
  content: string;
  updated_at: string;
  note_shares: { count: number }[];
}

interface SharedRow {
  permission: Permission;
  note: { id: string; title: string; content: string; updated_at: string; author: Profile | null } | null;
}

async function loadItems(tab: Tab, userId: string): Promise<Item[]> {
  if (tab === "mine") {
    const { data, error } = await supabase
      .from("notes")
      .select("id, title, content, updated_at, note_shares(count)")
      .eq("author_id", userId)
      .order("updated_at", { ascending: false })
      .returns<MyNoteRow[]>();
    if (error) throw error;
    return data.map(({ note_shares, ...note }) => {
      const count = note_shares[0]?.count ?? 0;
      return { ...note, detail: count ? `Shared with ${count}` : "Private" };
    });
  }
  const { data, error } = await supabase
    .from("note_shares")
    .select(`permission, note:notes(id, title, content, updated_at, author:profiles!notes_author_id_fkey(${PROFILE}))`)
    .eq("user_id", userId)
    .returns<SharedRow[]>();
  if (error) throw error;
  return data
    .flatMap(({ permission, note }) =>
      note ? [{ ...note, detail: `From ${note.author?.display_name ?? "unknown"}`, badge: permission === "edit" ? "Can edit" : "Read only", permission }] : [],
    )
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function NoteList({ tab, userId, selectedId, version }: {
  tab: Tab;
  userId: string;
  selectedId: string | null;
  version: number;
}) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    loadItems(tab, userId)
      .then((next) => current && setItems(next))
      .catch((e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [tab, userId, version]);

  async function create() {
    const { data, error } = await supabase.from("notes").insert({ title: "Untitled" }).select("id").single();
    if (error) return setError(error.message);
    go("mine", data.id);
  }

  return (
    <div className="note-list">
      {tab === "mine" && <button className="primary new-note" onClick={create}>New note</button>}
      {items?.length === 0 && (
        <p className="muted small">{tab === "mine" ? "No notes yet." : "Nobody has shared a note with you yet."}</p>
      )}
      <ul>
        {items?.map((item) => (
          <li key={item.id}>
            <a href={`#/${tab}/${item.id}`} className={item.id === selectedId ? "selected" : undefined}>
              <span className="note-title">{item.title || "Untitled"}</span>
              <span className="excerpt">{item.content.replace(/[#*`>-]/g, "").slice(0, 90) || "Empty note"}</span>
              <span className="meta">
                {formatDate(item.updated_at)} · {item.detail}
                {item.badge && <span className={`badge role-${item.permission}`}>{item.badge}</span>}
              </span>
            </a>
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
