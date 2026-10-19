import { describe, expect, it } from "vitest";
import { boxOfToken, boxToken, vscodeToken } from "./boxes.ts";

const SECRET = "s".repeat(32);

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
