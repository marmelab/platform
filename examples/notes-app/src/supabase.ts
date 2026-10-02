import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) throw new Error("VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set at build time");

export const supabase = createClient(url, anonKey);

export type Permission = "read" | "edit";
export type Role = "owner" | Permission;
export type Tab = "mine" | "shared";

export interface Profile {
  id: string;
  email: string;
  display_name: string;
}

export interface Share {
  user_id: string;
  permission: Permission;
  profile: Profile | null;
}

export interface Note {
  id: string;
  author_id: string;
  title: string;
  content: string;
  updated_at: string;
  author: Profile | null;
  editor: Profile | null;
  note_shares: Share[];
}

export const PROFILE = "id, email, display_name";

export function formatDate(iso: string) {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
