import { useLogout, useMe } from "../api.ts";
import { setAdminMode, setLiveMode, useAdminMode, useLiveMode } from "../settings.ts";
import { Avatar } from "./Avatar.tsx";
import { Menu } from "./Menu.tsx";

/** Who's logged in, as an avatar that opens admin mode, live mode and logging out. */
export function UserMenu() {
  const me = useMe();
  const admin = useAdminMode();
  const liveMode = useLiveMode();
  const logout = useLogout();
  const name = me.data?.name ?? "";
  return (
    <span className="user">
      {liveMode && <span className="live-flag">live</span>}
      {admin && <span className="admin-flag">admin</span>}
      <Menu align="end" className="user-button" title={`${name}: account`} label={<Avatar name={name} />}>
        <p className="menu-heading">{name}</p>
        <label className="menu-switch">
          <input type="checkbox" checked={admin} onChange={(e) => setAdminMode(e.target.checked)} />
          <span>
            Admin mode
            <small>Shows room-wide controls: editing lights on the map, and clearing every shader. Anyone can turn it on; it only guards against slips.</small>
          </span>
        </label>
        <label className="menu-switch">
          <input type="checkbox" checked={liveMode} onChange={(e) => setLiveMode(e.target.checked)} />
          <span>
            Live
            <small>Skips the preview: changes go to the room as you make them, with nothing to apply.</small>
          </span>
        </label>
        <button className="menu-item" onClick={() => logout.mutate()} disabled={logout.isPending}>
          Log out
        </button>
      </Menu>
    </span>
  );
}
