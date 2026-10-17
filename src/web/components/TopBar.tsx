import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LightInfo } from "../../shared/arclamp.ts";
import { lemtoneOf } from "../../shared/fixtures.ts";
import { lookOf, swatch } from "../../shared/lemtone.ts";
import type { SceneNode } from "../../shared/vibes.ts";
import { useHealth, useLogout, useMe, useStatus } from "../api.ts";
import { applyDraft, drafts } from "../draft.ts";
import { latestFrame, useStreamConnected } from "../live.ts";
import { setAdminMode, useAdminMode } from "../settings.ts";

interface Props {
  lights: LightInfo[];
  /** The live scene, which Apply changes. */
  live: SceneNode[];
  /** How many changes are waiting to be applied (simulated mode when any). */
  pending: number;
  onHistory: () => void;
}

export function TopBar({ lights, live, pending, onHistory }: Props) {
  const me = useMe();
  const admin = useAdminMode();
  return (
    <header className="topbar">
      <span className="brand">
        <RoomGlow lights={lights} />
        <span className="wordmark">vibes</span>
      </span>
      <Status pending={pending} />
      <span className="spacer" />
      {admin && <span className="admin-flag">admin mode</span>}
      <button className="text-button" onClick={onHistory}>
        History
      </button>
      <Menu label={me.data?.name ?? ""}>
        <label className="menu-switch">
          <input type="checkbox" checked={admin} onChange={(e) => setAdminMode(e.target.checked)} />
          <span>
            Admin mode
            <small>Shows room-wide controls, like clearing every shader. Anyone can turn it on; it only guards against slips.</small>
          </span>
        </label>
        <LogOut />
      </Menu>
      {pending > 0 && <Pending live={live} pending={pending} />}
    </header>
  );
}

/** Simulated mode's controls: send the pending changes to the room, or drop them. */
function Pending({ live, pending }: { live: SceneNode[]; pending: number }) {
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apply = async () => {
    setApplying(true);
    setError(null);
    try {
      await applyDraft(live);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setApplying(false);
    }
  };
  return (
    <span className="pending" role="group" aria-label="Pending changes">
      <span className="sim-flag" title="The map shows a preview; the room hasn't changed yet">
        {pending} {pending === 1 ? "change" : "changes"}
      </span>
      {error && (
        <span className="pending-error" title={error}>
          Couldn't apply: {error}
        </span>
      )}
      <button
        className="text-button"
        onClick={() => {
          setError(null);
          drafts.discard();
        }}
        disabled={applying}
      >
        Discard
      </button>
      <button className="primary" onClick={() => void apply()} disabled={applying}>
        {applying ? "Applying…" : "Apply"}
      </button>
    </span>
  );
}

/** A dot glowing with the room's average color right now. */
function RoomGlow({ lights }: { lights: LightInfo[] }) {
  const [color, setColor] = useState("#2a2622");
  useEffect(() => {
    const t = window.setInterval(() => {
      const frame = latestFrame();
      if (!frame || lights.length === 0) return;
      // The room's average look: each light's color, dimmed by how bright it looks.
      const sum = [0, 0, 0];
      for (const l of lights) {
        const t = lemtoneOf(frame.lights.get(l.id), l.type);
        if (!t) continue;
        const k = lookOf(t.brightness);
        swatch(t.a, t.b).forEach((v, i) => (sum[i]! += v * k));
      }
      const [r, g, b] = sum.map((v) => Math.round(Math.min(1, (v / lights.length) * 1.5) * 255));
      setColor(`rgb(${r} ${g} ${b})`);
    }, 400);
    return () => window.clearInterval(t);
  }, [lights]);
  return <span className="room-glow" style={{ background: color, boxShadow: `0 0 12px 1px ${color}` }} />;
}

function Status({ pending }: { pending: number }) {
  const status = useStatus();
  const health = useHealth();
  const stream = useStreamConnected();
  let text = "connecting";
  let tone = "";
  if (status.data?.arclamp === "unreachable") [text, tone] = ["arclamp unreachable", "bad"];
  else if (status.data?.arclamp === "rejected") [text, tone] = ["arclamp refused vibes' key", "bad"];
  else if (health.data && health.data.radios.some((r) => !r.connected)) [text, tone] = ["radio offline", "warn"];
  else if (pending > 0) [text, tone] = ["simulated", "sim"];
  else if (health.data?.dry_run) text = "dry run";
  else if (status.data && stream) text = "live";
  else if (status.data) [text, tone] = ["no live data", "warn"];

  const radios = health.data?.radios ?? [];
  const failing = health.data?.nodes.filter((n) => n.state !== "running") ?? [];
  return (
    <Menu label={text} className={`status ${tone}`}>
      <div className="status-detail">
        {pending > 0 && <p>The map shows a preview of your changes. The room won't change until you apply them.</p>}
        {health.data?.dry_run ? (
          <p>arclamp is running without a radio (a dry run), so no real lights change.</p>
        ) : radios.length === 0 ? (
          <p>No base stations configured.</p>
        ) : (
          radios.map((r) => (
            <p key={r.name}>
              <strong>{r.name}</strong>{" "}
              {r.connected ? (
                <span className="mono">
                  ch {r.channel} · {r.pps.toFixed(0)} pkt/s · {(r.lat_avg_us / 1000).toFixed(1)} ms
                  {r.dropped > 0 && ` · ${r.dropped} dropped`}
                </span>
              ) : (
                <span className="bad">disconnected</span>
              )}
            </p>
          ))
        )}
        {failing.length > 0 && (
          <p className="warn">
            {failing.length} shader{failing.length === 1 ? " isn't" : "s aren't"} running.
          </p>
        )}
      </div>
    </Menu>
  );
}

function LogOut() {
  const logout = useLogout();
  return (
    <button className="menu-item" onClick={() => logout.mutate()} disabled={logout.isPending}>
      Log out
    </button>
  );
}

/** A button that opens a small panel beneath it; closes on outside click or Escape. */
function Menu({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <span className="menu" ref={ref}>
      <button className={`text-button ${className ?? ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && <div className="menu-panel">{children}</div>}
    </span>
  );
}
