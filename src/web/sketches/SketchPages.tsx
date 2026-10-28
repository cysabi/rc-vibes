// A sketch's page: /sketches/<id> is one, in your own VS Code (your box:
// your clone of it, on your own branch) under vibes' bar. The preview and
// console are panels inside VS Code (the extension in box/extension), so
// this page is just the way in. The library of sketches is the dialog on
// the room's page (components/AddSketch.tsx).

import { useState, type MouseEvent, type ReactNode } from "react";
import { boxCommitFolder, type Sketch } from "../../shared/vibes.ts";
import { RequestError, useBox, useDeleteSketch, useRestoreSketch, useSketch } from "../api.ts";
import { useLights } from "../scene.ts";
import { Brand } from "../components/Brand.tsx";
import { UserMenu } from "../components/UserMenu.tsx";
import { TrashIcon } from "../icons.tsx";
import { navigate, useQueryParam } from "../route.ts";
import { ago } from "../words.ts";
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

export function SketchPages({ path }: { path: string }) {
  const id = path.replace(/^\/sketches\/?/, "").split("/")[0];
  return <SketchPage id={id!} />;
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
      <button className="quiet danger" disabled={remove.isPending} onClick={() => remove.mutate(sketch.id, { onSuccess: () => navigate("/") })}>
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
  const url = ready && (commit ? inFolder(ready.url, boxCommitFolder(commit)) : ready.url);
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
          {commit ? (
            <>
              <Link to={`/sketches/${id}`} className="crumb-name">
                {sketch.data?.name ?? "…"}
              </Link>
              <span className="crumb-sep">@</span>
              <span className="crumb-commit">
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
          Couldn't open this sketch: {sketch.error.message}. <Link to="/">Back to the room</Link>
        </Notice>
      ) : deleted ? (
        <Notice>
          <b>{sketch.data!.name}</b> was deleted {ago(deleted.at)} by {deleted.by}. Anyone can restore it.{" "}
          <button className="quiet" disabled={restore.isPending} onClick={() => restore.mutate(id)}>
            Restore it
          </button>{" "}
          <Link to="/">Back to the room</Link>
        </Notice>
      ) : shown ? (
        <div className="box-stage">
          <iframe key={`${shown.run} ${shown.url}`} className="box-frame" src={shown.url} aria-label={`${sketch.data?.name ?? "The sketch"} in VS Code`} allow="clipboard-read; clipboard-write" />
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
