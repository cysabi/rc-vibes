// Sketches, as their own pages: /sketches lists them, and /sketches/<id> is
// one, in your own VS Code (your box: your clone of it, on your own branch)
// under vibes' bar. The preview and console are panels inside VS Code (the
// extension in box/extension), so this page is just the way in.

import { useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { BOX_COMMITS_FOLDER, type Sketch } from "../../shared/vibes.ts";
import {
  RequestError,
  useBox,
  useCreateSketch,
  useDeletedSketches,
  useDeleteSketch,
  useLights,
  useRestoreSketch,
  useSketch,
  useSketches,
  useStatus,
} from "../api.ts";
import { Brand } from "../components/Brand.tsx";
import { UserMenu } from "../components/UserMenu.tsx";
import { ChevronUpIcon, PlusIcon, TrashIcon } from "../icons.tsx";
import { navigate, useQueryParam } from "../route.ts";
import "./sketches.css";

/** A link that moves within the app rather than loading the page again. */
function Link({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  const go = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} className={className} onClick={go}>
      {children}
    </a>
  );
}

/** The way in from the map: a button in the HUD, beside the account, while sketches are on. */
export function SketchesLink() {
  const status = useStatus();
  if (!status.data?.sketches) return null;
  return (
    <Link to="/sketches" className="glass-button sketches-link">
      <CodeIcon /> Sketches
    </Link>
  );
}

export function SketchPages({ path }: { path: string }) {
  const id = path.replace(/^\/sketches\/?/, "").split("/")[0];
  return id ? <SketchPage id={id} /> : <Library />;
}

function TopBar({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  const lights = useLights();
  return (
    <header className="page-bar">
      <Link to="/" className="page-brand">
        <Brand lights={lights.data?.lights ?? []} />
      </Link>
      {children}
      <span className="spacer" />
      {actions}
      <UserMenu />
    </header>
  );
}

function Library() {
  const sketches = useSketches();
  const [search, setSearch] = useState("");
  const shown = (sketches.data ?? []).filter((s) => s.name.toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <div className="sketch-page">
      <TopBar>
        <nav className="crumbs">
          <Link to="/">Room</Link>
          <span className="crumb-sep">/</span>
          <span>Sketches</span>
        </nav>
      </TopBar>
      <main className="library-main">
        <div className="library-intro">
          <h1>Sketches</h1>
          <p>Code that lights the room. Anyone can open one and change it, in their own copy, and share it back with git.</p>
        </div>
        <div className="library-toolbar">
          <input className="library-search" placeholder="Search sketches" value={search} onChange={(e) => setSearch(e.target.value)} />
          <span className="spacer" />
          <RecentlyDeleted />
          <NewSketch />
        </div>
        {sketches.isError && <p className="error-text">Couldn't load the sketches: {sketches.error.message}</p>}
        {sketches.data?.length === 0 && <p className="library-empty">No sketches yet. Make the first one.</p>}
        <ul className="sketch-grid">
          {shown.map((s) => (
            <li key={s.id}>
              <Link to={`/sketches/${s.id}`} className="sketch-card">
                <span className="card-name">{s.name}</span>
                <span className="card-meta">by {s.createdBy.name}</span>
                <span className="card-meta">
                  changed {ago(s.updatedAt)} by {s.updatedBy}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}

/**
 * The deleted sketches, in a dropdown, for anyone to restore. ?deleted=<id>
 * opens it with that one picked out: where a deleted sketch's shader in the
 * room sends you.
 */
function RecentlyDeleted() {
  const deleted = useDeletedSketches();
  const restore = useRestoreSketch();
  const picked = useQueryParam("deleted");
  const [open, setOpen] = useState(picked !== null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (picked !== null) setOpen(true);
  }, [picked]);
  // Closed by a click anywhere else, or Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  useEffect(() => {
    if (open) menu.current?.querySelector(".picked")?.scrollIntoView({ block: "nearest" });
  }, [open, deleted.data]);
  if (!deleted.data?.length) return null;
  return (
    <div className="deleted-menu" ref={menu}>
      <button className={open ? "quiet open" : "quiet"} aria-expanded={open} onClick={() => setOpen(!open)}>
        <TrashIcon /> Recently deleted <span className="count">{deleted.data.length}</span>
        <span className="chevron" aria-hidden="true">
          <ChevronUpIcon />
        </span>
      </button>
      {open && (
        <div className="deleted-panel">
          <p>Anyone can restore these, for everyone.</p>
          <ul>
            {deleted.data.map((s) => (
              <li key={s.id} className={s.id === picked ? "picked" : undefined}>
                <span className="deleted-text">
                  <span className="card-name">{s.name}</span>
                  <span className="card-meta">
                    deleted {ago(s.deleted!.at)} by {s.deleted!.by}
                  </span>
                </span>
                <button className="quiet" disabled={restore.isPending} onClick={() => restore.mutate(s.id)}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
          {restore.isError && <p className="error-text">Couldn't restore it: {restore.error.message}</p>}
        </div>
      )}
    </div>
  );
}

function NewSketch() {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const create = useCreateSketch();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate(name.trim(), { onSuccess: (s) => navigate(`/sketches/${s.id}`) });
  };
  if (!naming) {
    return (
      <button className="primary" onClick={() => setNaming(true)}>
        <PlusIcon /> New sketch
      </button>
    );
  }
  return (
    <form className="new-sketch" onSubmit={submit}>
      <input autoFocus placeholder="Its name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      <button className="primary" type="submit" disabled={!name.trim() || create.isPending}>
        Make it
      </button>
      <button className="quiet" type="button" onClick={() => setNaming(false)}>
        Cancel
      </button>
      {create.isError && <p className="error-text">{create.error.message}</p>}
    </form>
  );
}

/** Deleting a sketch, from its page: asked once more first, in the bar. */
function DeleteSketch({ sketch }: { sketch: Sketch }) {
  const [asking, setAsking] = useState(false);
  const remove = useDeleteSketch();
  if (!asking) {
    return (
      <button className="quiet delete-sketch" onClick={() => setAsking(true)}>
        <TrashIcon /> Delete
      </button>
    );
  }
  return (
    <div className="confirm-delete">
      <span>
        Delete <b>{sketch.name}</b> for everyone? Anyone can restore it.
      </span>
      <button className="quiet danger" disabled={remove.isPending} onClick={() => remove.mutate(sketch.id, { onSuccess: () => navigate("/sketches") })}>
        Delete it
      </button>
      <button className="quiet" onClick={() => setAsking(false)}>
        Cancel
      </button>
      {remove.isError && <span className="error-text">{remove.error.message}</span>}
    </div>
  );
}

function SketchPage({ id }: { id: string }) {
  const sketch = useSketch(id);
  const deleted = sketch.data?.deleted;
  const restore = useRestoreSketch();
  // At one commit (?commit=), it opens in a checkout of just that commit, beside
  // your clone (the extension makes it): what a shader in the room was built
  // from. Without, it's your clone, on your branch.
  const asked = useQueryParam("commit");
  const commit = asked && COMMIT.test(asked) ? asked : null;
  // Not opened once it's deleted. (Asked for before the sketch itself is
  // known, so VS Code starts as soon as it can.)
  const box = useBox(id, !deleted);
  // The run of the box VS Code was loaded from. A box gone since (removed
  // while the page was out of sight, or ended) starts again as a new run,
  // whose VS Code can't carry on with the old one's page: it's loaded afresh
  // once that's ready, under a cover meanwhile. The files are all in its
  // home and the open tabs in the browser, so only undo history is lost.
  const [shown, setShown] = useState<{ run: string; url: string } | null>(null);
  const ready = box.data?.state === "ready" ? box.data : null;
  const url = ready && (commit ? inFolder(ready.url, `${BOX_COMMITS_FOLDER}/${commit}`) : ready.url);
  if (ready && url && (ready.run !== shown?.run || url !== shown.url)) setShown({ run: ready.run, url });
  // Deleted meanwhile is said below, once the sketch has been looked at again.
  const goneMeanwhile = box.error instanceof RequestError && box.error.status === 410;
  const failed = box.data?.state === "failed" ? box.data.error : box.isError && !goneMeanwhile ? box.error.message : null;
  const failure = failed !== null && (
    <>
      Couldn't start your VS Code: {failed}.{" "}
      <button className="quiet" onClick={() => void box.refetch()}>
        Try again
      </button>
    </>
  );
  return (
    <div className="sketch-page">
      <TopBar actions={sketch.data && !deleted && <DeleteSketch sketch={sketch.data} />}>
        <nav className="crumbs">
          <Link to="/">Room</Link>
          <span className="crumb-sep">/</span>
          <Link to="/sketches">Sketches</Link>
          <span className="crumb-sep">/</span>
          {commit ? (
            <>
              <Link to={`/sketches/${id}`} className="crumb-name">
                {sketch.data?.name ?? "…"}
              </Link>
              <span className="crumb-sep">@</span>
              <span className="crumb-commit" title={`At commit ${commit}. The sketch's name goes back to your branch.`}>
                {commit.slice(0, 7)}
              </span>
            </>
          ) : (
            <span className="crumb-name">{sketch.data?.name ?? "…"}</span>
          )}
        </nav>
      </TopBar>
      {sketch.isError ? (
        <Notice>
          Couldn't open this sketch: {sketch.error.message}. <Link to="/sketches">All sketches</Link>
        </Notice>
      ) : deleted ? (
        <Notice>
          <b>{sketch.data!.name}</b> was deleted {ago(deleted.at)} by {deleted.by}. Anyone can restore it.{" "}
          <button className="quiet" disabled={restore.isPending} onClick={() => restore.mutate(id)}>
            Restore it
          </button>{" "}
          <Link to="/sketches">All sketches</Link>
        </Notice>
      ) : shown ? (
        <div className="box-stage">
          <iframe key={`${shown.run} ${shown.url}`} className="box-frame" src={shown.url} title={`${sketch.data?.name ?? "The sketch"} in VS Code`} allow="clipboard-read; clipboard-write" />
          {!ready && <div className={failure ? "box-notice box-cover" : "box-notice box-cover starting"}>{failure ? <p>{failure}</p> : <p>Waking your VS Code…</p>}</div>}
        </div>
      ) : failure ? (
        <Notice>{failure}</Notice>
      ) : (
        <Notice starting>
          Starting your VS Code, with your own copy of {sketch.data ? <b>{sketch.data.name}</b> : "the sketch"}…
        </Notice>
      )}
    </div>
  );
}

const COMMIT = /^[0-9a-f]{7,40}$/;

/** VS Code's address, opening another folder. */
function inFolder(url: string, folder: string): string {
  const u = new URL(url, location.origin);
  u.searchParams.set("folder", folder);
  return u.pathname + u.search;
}

function Notice({ children, starting }: { children: ReactNode; starting?: boolean }) {
  return (
    <div className={starting ? "box-notice starting" : "box-notice"}>
      <p>{children}</p>
    </div>
  );
}

/** How long ago, roughly: "just now", "5 minutes ago", "yesterday", "3 weeks ago". */
function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  const units: [number, string][] = [
    [60 * 60 * 24 * 365, "year"],
    [60 * 60 * 24 * 30, "month"],
    [60 * 60 * 24 * 7, "week"],
    [60 * 60 * 24, "day"],
    [60 * 60, "hour"],
    [60, "minute"],
  ];
  for (const [size, unit] of units) {
    const n = Math.floor(s / size);
    if (n >= 1) return unit === "day" && n === 1 ? "yesterday" : `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

const CodeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 4L2 8l4 4M10 4l4 4-4 4" />
  </svg>
);
