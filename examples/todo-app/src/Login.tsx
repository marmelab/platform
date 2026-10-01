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
    <form
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        submit("signIn");
      }}
    >
      <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        minLength={6}
        required
      />
      <div className="row">
        <button type="submit">Sign in</button>
        <button type="button" onClick={() => submit("signUp")}>
          Sign up
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
