import { type FormEvent, useState } from "react";
import { supabase } from "./supabase";

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function submit(mode: "signIn" | "signUp") {
    setError(null);
    setInfo(null);
    const credentials = { email, password };
    if (mode === "signIn") {
      const { error } = await supabase.auth.signInWithPassword(credentials);
      if (error) setError(error.message);
      return;
    }
    // when the app requires email confirmation, sign-up returns no session until the link in the email is opened
    const { data, error } = await supabase.auth.signUp({
      ...credentials,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) setError(error.message);
    else if (!data.session) setInfo("Check your email to confirm your address, then sign in.");
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
        {info && <p className="info">{info}</p>}
      </form>
    </div>
  );
}
