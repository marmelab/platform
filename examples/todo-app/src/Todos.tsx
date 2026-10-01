import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, type Todo } from "./supabase";

interface Summary {
  total: number;
  done: number;
}

export function Todos({ session }: { session: Session }) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data, error } = await supabase.from("todos").select("id, title, done, created_at").order("id");
    if (error) return setError(error.message);
    setTodos(data);
    const result = await supabase.functions.invoke<Summary>("summary");
    if (result.error) setError(result.error.message);
    else setSummary(result.data);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function run(promise: PromiseLike<{ error: { message: string } | null }>) {
    const { error } = await promise;
    if (error) setError(error.message);
    else refresh();
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim()) return;
    run(supabase.from("todos").insert({ title: title.trim() }));
    setTitle("");
  }

  return (
    <section>
      <p className="muted">
        {session.user.email} · <button className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </p>
      <form onSubmit={add} className="row">
        <input placeholder="What needs to be done?" value={title} onChange={(e) => setTitle(e.target.value)} />
        <button type="submit">Add</button>
      </form>
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>
            <label>
              <input
                type="checkbox"
                checked={todo.done}
                onChange={() => run(supabase.from("todos").update({ done: !todo.done }).eq("id", todo.id))}
              />
              <span className={todo.done ? "done" : undefined}>{todo.title}</span>
            </label>
            <button className="link" onClick={() => run(supabase.from("todos").delete().eq("id", todo.id))}>
              Delete
            </button>
          </li>
        ))}
      </ul>
      {summary && <p className="muted">{summary.done} of {summary.total} done</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
