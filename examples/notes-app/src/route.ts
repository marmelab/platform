import type { Tab } from "./supabase";

export interface Route {
  tab: Tab;
  noteId: string | null;
}

export function parseHash(): Route {
  const [tab, noteId] = window.location.hash.replace(/^#\/?/, "").split("/");
  return { tab: tab === "shared" ? "shared" : "mine", noteId: noteId || null };
}

export function go(tab: Tab, noteId?: string) {
  window.location.hash = noteId ? `/${tab}/${noteId}` : `/${tab}`;
}
