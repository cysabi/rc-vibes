import { useState, type FormEvent } from "react";
import { useDevLogin, useLoginOptions } from "../api.ts";

export function Login() {
  const options = useLoginOptions();
  const devLogin = useDevLogin();
  const [name, setName] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) devLogin.mutate(name.trim());
  };

  return (
    <div className="login">
      <div className="login-glow" aria-hidden="true" />
      <h1 className="wordmark">vibes</h1>
      <p>The lights at the Recurse Center.</p>
      {options.data?.rc && (
        <a className="button primary" href="/auth/login">
          Log in with your RC account
        </a>
      )}
      {options.data?.dev && (
        <form className="dev-login" onSubmit={submit}>
          <label htmlFor="dev-name">Development login: any name works</label>
          <span className="login-row">
            <input id="dev-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoFocus />
            <button className="primary" type="submit" disabled={!name.trim() || devLogin.isPending}>
              Log in
            </button>
          </span>
          {devLogin.error && <p className="error-text">{devLogin.error.message}</p>}
        </form>
      )}
    </div>
  );
}
