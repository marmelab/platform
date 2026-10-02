import { type FormEvent, useState } from "react";
import { supabase } from "./supabase";

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(mode: "signIn" | "signUp") {
    setError(null);
    const credentials = { email, password };
    const { error } = mode === "signIn"
      ? await supabase.auth.signInWithPassword(credentials)
      : await supabase.auth.signUp(credentials);
    if (error) setError(error.message);
  }

  return (
    <div className="login">
      <form
        className="card"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          submit("signIn");
        }}
      >
        <h1 className="brand">Notes</h1>
        <p className="muted">Write notes and share them with your team.</p>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={6}
            required
          />
        </label>
        <button type="submit" className="primary">Sign in</button>
        <button type="button" className="ghost" onClick={() => submit("signUp")}>
          Create an account
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}
