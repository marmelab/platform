import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) throw new Error("VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set at build time");

export const supabase = createClient(url, anonKey);
