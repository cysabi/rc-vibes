// Banners across the top of the whole site: the modes that change what your
// edits do (live mode: they reach the room as they're made; admin mode: its
// controls are out), and degraded states, anything that means the room isn't
// doing what vibes shows, or can't be changed from here. Nothing shows while
// all is well and neither mode's on.

import { useEffect, useState } from "react";
import { useHealth, useStatus } from "../api.ts";
import { useStreamConnected } from "../live.ts";
import { useAdminMode, useLiveMode } from "../settings.ts";

interface Banner {
  key: string;
  tone: "bad" | "warn" | "info" | "live" | "admin";
  title: string;
  detail: string;
}

// The live stream takes a moment to connect; only call it lost after this long.
const STREAM_GRACE_MS = 4000;

export function Banners() {
  const status = useStatus();
  const health = useHealth();
  const stream = useStreamConnected();
  const streamLost = useHeldFor(status.data?.arclamp === "ok" && !stream, STREAM_GRACE_MS);
  const liveMode = useLiveMode();
  const admin = useAdminMode();

  const banners: Banner[] = [];
  if (liveMode) banners.push({ key: "live", tone: "live", title: "Live mode", detail: "Changes go to the room as you make them." });
  if (admin) banners.push({ key: "admin", tone: "admin", title: "Admin mode", detail: "Editing lights and the map's timing are out." });
  if (status.error) {
    banners.push({ key: "vibes", tone: "bad", title: "Can't reach vibes", detail: "What you see may be out of date, and changes won't save." });
  } else if (status.data?.arclamp === "unreachable") {
    banners.push({ key: "arclamp", tone: "bad", title: "arclamp is unreachable", detail: "vibes can't see or change the lights until it's back." });
  } else if (status.data?.arclamp === "rejected") {
    banners.push({ key: "arclamp", tone: "bad", title: "arclamp refused vibes' key", detail: "Nothing can change until the key is fixed." });
  } else if (status.data?.arclamp === "ok") {
    const offline = health.data?.radios.filter((r) => !r.connected) ?? [];
    if (offline.length === 1) {
      banners.push({
        key: "radio",
        tone: "warn",
        title: `Radio ${offline[0]!.name} is disconnected`,
        detail: "The lights it drives won't follow changes until it reconnects.",
      });
    } else if (offline.length > 1) {
      banners.push({
        key: "radio",
        tone: "warn",
        title: `${offline.length} radios are disconnected`,
        detail: "The lights they drive won't follow changes until they reconnect.",
      });
    }
    if (health.data?.dry_run) {
      banners.push({ key: "dry-run", tone: "info", title: "Dry run", detail: "arclamp is running without a radio, so the real lights won't change." });
    }
    if (streamLost) {
      banners.push({ key: "stream", tone: "warn", title: "No live data from the room", detail: "The map may not match the lights." });
    }
  }

  if (banners.length === 0) return null;
  return (
    <div className="banners" role="status">
      {banners.map((b) => (
        <p key={b.key} className={`banner ${b.tone}`}>
          <span className="banner-dot" aria-hidden="true" />
          <strong>{b.title}</strong>
          <span>{b.detail}</span>
        </p>
      ))}
    </div>
  );
}

/** Whether `on` has been true for at least `ms`. */
function useHeldFor(on: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!on) {
      setHeld(false);
      return;
    }
    const t = window.setTimeout(() => setHeld(true), ms);
    return () => window.clearTimeout(t);
  }, [on, ms]);
  return on && held;
}
