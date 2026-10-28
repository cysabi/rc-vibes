import { useLogout, useMe } from "../api.ts";
import { setGamutChoice, setHdrChoice, useDisplay, type GamutChoice } from "../display.ts";
import { setAdminMode, setLiveMode, useAdminMode, useLiveMode } from "../settings.ts";
import { Avatar } from "./Avatar.tsx";
import { Menu } from "./Menu.tsx";
import { OthersHere } from "./OthersHere.tsx";
import { Segmented } from "./Segmented.tsx";
import { ShowMenuItem } from "./Transport.tsx";

const GAMUTS: { value: GamutChoice; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "srgb", label: "sRGB" },
  { value: "display-p3", label: "P3" },
];

/** Who's logged in (everyone else here beside them), as an avatar that opens live mode, admin controls, how colors show, starting or ending a show, and logging out. */
export function UserMenu() {
  const me = useMe();
  const admin = useAdminMode();
  const liveMode = useLiveMode();
  const display = useDisplay();
  const logout = useLogout();
  const name = me.data?.name ?? "";
  return (
    <span className="user">
      <OthersHere />
      <Menu align="end" className="user-button" name={name} label={<Avatar name={name} />}>
        <div className="menu-heading">
          <span>{name}</span>
          <button className="menu-item bad" onClick={() => logout.mutate()} disabled={logout.isPending}>
            Log out
          </button>
        </div>
        <MenuToggle label="Live Mode" off="Off" on="On" value={liveMode} onChange={setLiveMode} />
        <MenuToggle label="Admin Controls" off="Hide" on="Show" value={admin} onChange={setAdminMode} />
        <div className="menu-field">
          <span>Color Space</span>
          <Segmented label="Color Space" options={GAMUTS} value={display.gamutChoice} onChange={setGamutChoice} />
        </div>
        <MenuToggle label="HDR" off="Off" on="On" value={display.hdrChoice} onChange={setHdrChoice} />
        <ShowMenuItem />
      </Menu>
    </span>
  );
}

/** A setting's two states as a segmented control, off first. */
function MenuToggle({ label, off, on, value, onChange }: { label: string; off: string; on: string; value: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="menu-field">
      <span>{label}</span>
      <Segmented
        label={label}
        options={[
          { value: "off", label: off },
          { value: "on", label: on },
        ]}
        value={value ? "on" : "off"}
        onChange={(v) => onChange(v === "on")}
      />
    </div>
  );
}
