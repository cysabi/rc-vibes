import { useLogout, useMe } from "../api.ts";
import { setHdrChoice, useDisplay } from "../display.ts";
import { setAdminMode, setLiveMode, useAdminMode, useLiveMode } from "../settings.ts";
import { Avatar } from "./Avatar.tsx";
import { Menu } from "./Menu.tsx";
import { OthersHere } from "./OthersHere.tsx";
import { Segmented } from "./Segmented.tsx";

/** Who's logged in (everyone else here beside them), as an avatar that opens live mode, admin controls, how colors show, and logging out. */
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
        <MenuToggle label="HDR" off="Off" on="On" value={display.hdrChoice} onChange={setHdrChoice} />
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
