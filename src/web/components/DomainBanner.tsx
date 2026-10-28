// In the HUD while the map's about one layer (layer-mode.ts): its domain
// being edited, a pill saying whose, an × on its left to discard the edit,
// and saving it (as a pending edit) on its right. While it's in focus (just
// its lights on the map), the same pill says whose, its × leaving the focus,
// and editing its domain on its right. Its spacing is the tone box's
// (ColorField's White / Color tabs): its parts inset from its rim as far as
// they are from each other.

import type { Layer } from "../draft.ts";
import { domainChanged, type DomainEdit } from "../layer-mode.ts";
import { CloseIcon } from "../icons.tsx";

interface Props {
  layer: Layer;
  edit: DomainEdit;
  onSave: () => void;
  onDiscard: () => void;
}

/** Closing the pill (whatever that means for it), at its left. */
const Close = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button className="domain-banner-close" aria-label={label} onClick={onClick}>
    <CloseIcon />
  </button>
);

/** A layer in focus: every light back (its ×), or its domain to edit (from the lights it's on). */
export function FocusBanner({ layer, onEdit, onExit }: { layer: Layer; onEdit: (() => void) | null; onExit: () => void }) {
  return (
    <div className="domain-banner-wrap">
      <div className="domain-banner" role="status">
        <Close label="Exit focus" onClick={onExit} />
        <span className="domain-banner-text">
          Focused on the domain of <b>{layer.name}</b>
        </span>
        {onEdit && (
          <button className="domain-banner-action" onClick={onEdit}>
            Edit
          </button>
        )}
      </div>
    </div>
  );
}

export function DomainBanner({ layer, edit, onSave, onDiscard }: Props) {
  return (
    <div className="domain-banner-wrap">
      <div className="domain-banner" role="status">
        <Close label="Discard" onClick={onDiscard} />
        <span className="domain-banner-text">
          Editing the domain of <b>{layer.name}</b>
        </span>
        <button className="domain-banner-action" disabled={!domainChanged(edit)} onClick={onSave}>
          Save
        </button>
      </div>
    </div>
  );
}
