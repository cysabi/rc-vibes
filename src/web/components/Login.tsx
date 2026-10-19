import { useState, type FormEvent } from "react";
import { useDevLogin, useLoginOptions } from "../api.ts";

// A dark room with a few lights drifting in it, behind the login.
const GLOWS = [
  { x: 22, y: 30, size: 520, color: "255 170 95", delay: 0 },
  { x: 78, y: 26, size: 460, color: "255 120 170", delay: -4 },
  { x: 64, y: 78, size: 560, color: "110 170 255", delay: -8 },
  { x: 30, y: 82, size: 420, color: "170 120 255", delay: -2 },
  { x: 50, y: 48, size: 380, color: "255 214 160", delay: -6 },
];

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
      <div className="login-room" aria-hidden="true">
        {GLOWS.map((g, i) => (
          <span
            key={i}
            style={{
              left: `${g.x}%`,
              top: `${g.y}%`,
              width: g.size,
              height: g.size,
              background: `radial-gradient(circle, rgb(${g.color} / 0.4), rgb(${g.color} / 0.1) 40%, transparent 68%)`,
              animationDelay: `${g.delay}s`,
            }}
          />
        ))}
      </div>
      <div className="login-card">
        <h1 className="wordmark">vibes</h1>
        <p>The lights at the Recurse Center.</p>
        {options.data?.rc && (
          <a className="button primary" href={`/auth/login?origin=${encodeURIComponent(location.origin)}`}>
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
    </div>
  );
}
