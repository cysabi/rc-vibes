// The stamp: the first line of every script vibes builds for the room, saying
// which sketch and commit it was built from, signed with vibes' own key
// (VIBES_SIGNING_KEY, which neither boxes nor builds ever see). It's how vibes
// tells its own shaders from anyone else's in rclamp, and notices one that's
// been changed there since: the signature covers the code under it too.
//
//   // vibes-stamp v1 sketch=<uuid> commit=<sha> builder=<version> key=<key id> sig=<HMAC-SHA256, base64url>
//
// The key id (the start of the key's SHA-256) lets the key be replaced: a
// stamp made with another key can't be checked, so it isn't trusted.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ShaderSketch } from "../shared/vibes.ts";
import type { Db } from "./db.ts";

/** What a stamp says a script is. */
export interface Stamp {
  sketch: string;
  /** The commit's full hash. */
  commit: string;
  /** The version of the builder that made it. */
  builder: string;
}

const SKETCH = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const COMMIT = "[0-9a-f]{40}";
const BUILDER = "[A-Za-z0-9._-]{1,40}";
const LINE = new RegExp(`^// vibes-stamp v1 sketch=(${SKETCH}) commit=(${COMMIT}) builder=(${BUILDER}) key=([0-9a-f]{8}) sig=([A-Za-z0-9_-]{43})\\n`);

/** Which key a stamp was made with, without giving any of it away. */
export const keyId = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 8);

const signature = (key: string, s: Stamp, kid: string, body: string) =>
  createHmac("sha256", key).update(`vibes-stamp v1\n${s.sketch}\n${s.commit}\n${s.builder}\n${kid}\n`).update(body).digest("base64url");

/** `body` (a built script) with a stamp on top. */
export function stamp(body: string, s: Stamp, key: string): string {
  if (!new RegExp(`^${SKETCH}$`).test(s.sketch) || !new RegExp(`^${COMMIT}$`).test(s.commit) || !new RegExp(`^${BUILDER}$`).test(s.builder)) {
    throw new Error("a stamp needs a sketch's id, a commit's full hash and a builder's version");
  }
  const kid = keyId(key);
  return `// vibes-stamp v1 sketch=${s.sketch} commit=${s.commit} builder=${s.builder} key=${kid} sig=${signature(key, s, kid, body)}\n${body}`;
}

/**
 * What a script's stamp says, and whether it's true: made with this key, over
 * exactly the code under it. null for a script with no stamp.
 */
export function readStamp(script: string, key: string | null): { stamp: Stamp; verified: boolean } | null {
  const m = LINE.exec(script);
  if (!m) return null;
  const [line, sketch, commit, builder, kid, sig] = m as unknown as [string, string, string, string, string, string];
  const s = { sketch, commit, builder };
  let verified = false;
  if (key && kid === keyId(key)) {
    const want = Buffer.from(signature(key, s, kid, script.slice(line.length)));
    const given = Buffer.from(sig);
    verified = want.length === given.length && timingSafeEqual(want, given);
  }
  return { stamp: s, verified };
}

/** The sketch a shader in the scene was built from, as its stamp says; undefined for one with no stamp. */
export function sketchOf(script: string | undefined, key: string | null, db: Pick<Db, "sketch">): ShaderSketch | undefined {
  const read = script ? readStamp(script, key) : null;
  if (!read) return undefined;
  const row = db.sketch(read.stamp.sketch);
  return {
    id: read.stamp.sketch,
    name: row?.name ?? null,
    commit: read.stamp.commit,
    edited: !read.verified,
    deleted: row ? row.deleted_at !== null : false,
  };
}
