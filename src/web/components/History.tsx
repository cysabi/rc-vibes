import type { ActivityAction, ActivityEntry } from "../../shared/vibes.ts";
import { useActivity } from "../api.ts";
import { BackIcon } from "../icons.tsx";

const VERBS: Record<ActivityAction, string> = {
  "shader.create": "created",
  "shader.edit": "edited",
  "shader.rename": "renamed",
  "shader.delete": "deleted",
  "shader.move": "moved",
  "shader.mute": "muted",
  "shader.unmute": "unmuted",
  "roomtone.set": "",
  "scene.clear": "cleared every shader",
  "lights.move": "",
  "lights.turn": "",
  "rails.change": "",
};

const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const day = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" });

export function History({ onBack }: { onBack: () => void }) {
  const activity = useActivity();
  const entries = activity.data ?? [];
  const days = new Map<string, ActivityEntry[]>();
  for (const e of entries) {
    const key = dayLabel(new Date(e.ts));
    days.set(key, [...(days.get(key) ?? []), e]);
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <button className="icon-button" onClick={onBack} aria-label="Back to the stack">
          <BackIcon />
        </button>
        <h2>History</h2>
      </div>
      {activity.error && <p className="error-text">{activity.error.message}</p>}
      {activity.data && entries.length === 0 && <p className="empty">Nothing has changed through vibes yet.</p>}
      {[...days].map(([label, list]) => (
        <section key={label} className="history-day">
          <h3 className="section-title">{label}</h3>
          <ol className="history">
            {list.map((e) => (
              <li key={e.id}>
                <time className="mono" dateTime={e.ts}>
                  {time.format(new Date(e.ts))}
                </time>
                <span>
                  <strong>{e.user.name}</strong> {VERBS[e.action] || null}
                  {e.shaderName && <> <em>{e.shaderName}</em></>}
                  {describe(e)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function dayLabel(d: Date): string {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return day.format(d);
}

function describe(entry: ActivityEntry) {
  const d = entry.detail;
  if (!d) return null;
  if (entry.action === "shader.rename" && typeof d.from === "string") return ` (was ${d.from})`;
  if (entry.action === "shader.move" && typeof d.from === "number" && typeof d.to === "number") {
    // Higher positions draw on top, and the stack lists the top first.
    const steps = Math.abs(d.to - d.from);
    return ` ${d.to > d.from ? "up" : "down"} ${steps}`;
  }
  if (entry.action === "scene.clear" && typeof d.removed === "number") return ` (${d.removed})`;
  if (entry.action === "lights.move" && typeof d.lights === "number") {
    return `moved ${d.lights} ${d.lights === 1 ? "light" : "lights"} on the map`;
  }
  if (entry.action === "lights.turn" && typeof d.lights === "number") {
    return `turned ${d.lights} ${d.lights === 1 ? "panel" : "panels"}`;
  }
  if (entry.action === "rails.change" && typeof d.rails === "number") {
    return `changed ${d.rails} ${d.rails === 1 ? "rail" : "rails"} on the map`;
  }
  if (entry.action === "roomtone.set") {
    const n = typeof d.lights === "number" ? d.lights : Array.isArray(d.lights) ? d.lights.length : 0;
    const lights = `${n} ${n === 1 ? "light" : "lights"}`;
    if (d.undo) return `undid a room tone change on ${lights}`;
    if (d.code === "on" || d.code === "off") return `switched ${n} old ${n === 1 ? "bulb" : "bulbs"} ${d.code}`;
    if (typeof d.code === "string") {
      return (
        <>
          set {lights} to <span className="mono">{d.code}</span>
        </>
      );
    }
    return `changed the room tone on ${lights}`;
  }
  return null;
}
