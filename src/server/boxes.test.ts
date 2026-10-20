import { afterEach, describe, expect, it } from "vitest";
import type { BoxState, Me } from "../shared/vibes.ts";
import { boxOfToken, boxToken, createBoxes, vscodeToken, type Boxes } from "./boxes.ts";
import { openDb, type Db } from "./db.ts";
import { loadConfig } from "./env.ts";
import { fakeBoxRunner } from "./fake-box-runner.ts";

const SECRET = "s".repeat(32);
const ada: Me = { id: "rc:1", name: "Ada Lovelace", dev: false };
const grace: Me = { id: "rc:2", name: "Grace", dev: false };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(ready: () => boolean) {
  for (let i = 0; i < 100 && !ready(); i++) await sleep(20);
  expect(ready()).toBe(true);
}

const configWith = (env: Record<string, string>) =>
  loadConfig({
    ARCLAMP_BASE_URL: "http://127.0.0.1:1",
    ARCLAMP_KEY: "k",
    SESSION_SECRET: SECRET,
    VIBES_DEV_LOGIN: "1",
    SKETCHES: "1",
    BOX_IMAGE: "vibes-box:new",
    BOX_VIBES_URL: "http://vibes.test",
    ...env,
  });

let fake: ReturnType<typeof fakeBoxRunner>;
let made: Boxes[] = [];

function boxesWith(env: Record<string, string>, db: Db = openDb(":memory:")) {
  const config = configWith(env);
  const boxes = createBoxes(config, config.sketches!, db, fake.runner);
  made.push(boxes);
  return { boxes, db };
}

/** Someone's box for a sketch, checked in on until it's started. */
async function open(boxes: Boxes, who: Me, sketch = "sketch-1"): Promise<BoxState> {
  for (let i = 0; i < 100; i++) {
    const state = await boxes.ensure(sketch, who);
    if (state.state !== "starting") return state;
    await sleep(20);
  }
  throw new Error("it never started");
}

const run = (state: BoxState) => (state.state === "ready" ? state.run : null);

/** Waits until the pool's boxes have all been found waiting. */
const pooled = (n: number) => until(() => fake.boxes.size === n && [...fake.boxes.values()].every((b) => b.asked || b.claim)).then(() => sleep(20));

afterEach(() => {
  for (const boxes of made) boxes.stop();
  made = [];
  fake?.close();
});

describe("boxes", () => {
  it("wait in a pool, and opening a sketch claims one for that person, then tops the pool up", async () => {
    fake = fakeBoxRunner();
    const { boxes, db } = boxesWith({ BOX_POOL: "2" });
    await pooled(2);
    const waiting = [...fake.boxes.keys()];

    const mine = await open(boxes, ada);
    expect(waiting).toContain(run(mine));
    const row = db.boxFor("sketch-1", ada.id)!;
    expect(row.pod).toBe(run(mine));
    expect(fake.boxes.get(run(mine)!)!.claim).toMatchObject({
      box: row.id,
      env: { VIBES_BOX_ID: row.id, VIBES_BOX_TOKEN: boxToken(SECRET, row.id), VIBES_BASE_PATH: `/box/${row.id}` },
    });
    // Everyone's clone is on main: no branch of their own.
    expect(fake.boxes.get(run(mine)!)!.claim!.env).not.toHaveProperty("VIBES_BRANCH");
    expect(boxes.target(row.id)).toBe(fake.boxes.get(run(mine)!)!.target);
    await pooled(3);

    const theirs = await open(boxes, grace);
    expect(run(theirs)).not.toBe(run(mine));
    expect(waiting).toContain(run(theirs));
    // Checking in again is the same run.
    expect(run(await open(boxes, ada))).toBe(run(mine));
  });

  it("boot one on the spot when none are waiting", async () => {
    fake = fakeBoxRunner();
    const { boxes } = boxesWith({ BOX_POOL: "0" });
    expect(await open(boxes, ada)).toMatchObject({ state: "ready" });
    expect(fake.boxes.size).toBe(1);
  });

  it("pass over a waiting box that's ended", async () => {
    fake = fakeBoxRunner();
    const { boxes } = boxesWith({ BOX_POOL: "1" });
    await pooled(1);
    const [dead] = fake.boxes.keys();
    fake.crash(dead!);
    const state = await open(boxes, ada);
    expect(state).toMatchObject({ state: "ready" });
    expect(run(state)).not.toBe(dead);
    expect(fake.boxes.has(dead!)).toBe(false);
  });

  it("are removed once nothing's checked in on them for a while, and a check-in after starts a new run", async () => {
    fake = fakeBoxRunner();
    const { boxes, db } = boxesWith({ BOX_POOL: "0", BOX_IDLE_MINUTES: "0.002" });
    const first = run(await open(boxes, ada));
    await until(() => !fake.boxes.has(first!));
    expect(db.boxFor("sketch-1", ada.id)!.pod).toBeNull();
    const second = run(await open(boxes, ada));
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it("start again, as a new run, when theirs has ended", async () => {
    fake = fakeBoxRunner();
    const { boxes } = boxesWith({ BOX_POOL: "0" });
    const first = run(await open(boxes, ada));
    fake.crash(first!);
    expect(await boxes.ensure("sketch-1", ada)).toEqual({ state: "starting" });
    const second = run(await open(boxes, ada));
    expect(second).not.toBe(first);
    expect(fake.boxes.has(first!)).toBe(false);
  });

  it("left from before vibes restarted carry on if they're someone's, go back in the pool if they're waiting, and otherwise go", async () => {
    fake = fakeBoxRunner();
    const before = boxesWith({ BOX_POOL: "1" });
    const mine = run(await open(before.boxes, ada));
    await pooled(2);
    before.boxes.stop();
    const [waiting] = [...fake.boxes.keys()].filter((n) => n !== mine);
    await fake.runner.boot("box-old", "vibes-box:old", { VIBES_CLAIM_TOKEN: "x" });

    const after = boxesWith({ BOX_POOL: "1" }, before.db);
    expect(run(await open(after.boxes, ada))).toBe(mine);
    await until(() => !fake.boxes.has("box-old"));
    // The waiting one was taken back: nothing new was booted.
    await sleep(100);
    expect([...fake.boxes.keys()].sort()).toEqual([mine, waiting].sort());
  });

  it("left from before a deploy with a new image go, someone's too, and start again on the new one", async () => {
    fake = fakeBoxRunner();
    const before = boxesWith({ BOX_POOL: "0", BOX_IMAGE: "vibes-box:old" });
    const old = run(await open(before.boxes, ada));
    before.boxes.stop();

    const after = boxesWith({ BOX_POOL: "0", BOX_IMAGE: "vibes-box:new" }, before.db);
    expect(await after.boxes.ensure("sketch-1", ada)).toEqual({ state: "starting" });
    const fresh = run(await open(after.boxes, ada));
    expect(fresh).not.toBe(old);
    expect(fake.boxes.has(old!)).toBe(false);
    expect(fake.boxes.get(fresh!)!.image).toBe("vibes-box:new");
  });
});

describe("box tokens", () => {
  it("say which box they're for", () => {
    expect(boxOfToken(SECRET, boxToken(SECRET, "box-1"))).toBe("box-1");
  });

  it("can't be forged, or moved to another box", () => {
    const token = boxToken(SECRET, "box-1");
    expect(boxOfToken(SECRET, token.replace("box-1", "box-2"))).toBeNull();
    expect(boxOfToken(SECRET, `${token}x`)).toBeNull();
    expect(boxOfToken("t".repeat(32), token)).toBeNull();
    expect(boxOfToken(SECRET, "nonsense")).toBeNull();
  });

  it("differ from the box's VS Code connection token", () => {
    expect(vscodeToken(SECRET, "box-1")).not.toBe(boxToken(SECRET, "box-1").split(".")[1]);
    expect(vscodeToken(SECRET, "box-1")).not.toBe(vscodeToken(SECRET, "box-2"));
  });
});
