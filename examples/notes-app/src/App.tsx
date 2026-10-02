import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { go, parseHash } from "./route";
import { Login } from "./Login";
import { NoteList } from "./NoteList";
import { NoteEditor } from "./NoteEditor";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [route, setRoute] = useState(parseHash);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => {
      data.subscription.unsubscribe();
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  if (!ready) return null;
  if (!session) return <Login />;

  const userId = session.user.id;
  const changed = () => setVersion((v) => v + 1);

  return (
    <div className={route.noteId ? "layout has-note" : "layout"}>
      <aside className="sidebar">
        <header className="sidebar-header">
          <span className="brand">Notes</span>
          <button
            className="link"
            onClick={() => {
              go("mine");
              supabase.auth.signOut();
            }}
          >
            Sign out
          </button>
        </header>
        <p className="muted small">{session.user.email}</p>
        <nav className="tabs">
          <a href="#/mine" className={route.tab === "mine" ? "active" : undefined}>My notes</a>
          <a href="#/shared" className={route.tab === "shared" ? "active" : undefined}>Shared with me</a>
        </nav>
        <NoteList tab={route.tab} userId={userId} selectedId={route.noteId} version={version} />
      </aside>
      <main className="pane">
        {route.noteId ? (
          <NoteEditor key={route.noteId} noteId={route.noteId} tab={route.tab} userId={userId} onChange={changed} />
        ) : (
          <div className="empty">
            <p>{route.tab === "mine" ? "Select a note or create a new one." : "Select a note shared with you."}</p>
          </div>
        )}
      </main>
    </div>
  );
}
