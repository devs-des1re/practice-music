import { Dialog } from "../ui/dialog";
import { SHORTCUTS } from "../../lib/shortcuts";

export interface ShortcutsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function ShortcutsDialog(props: ShortcutsDialogProps) {
  return (
    <Dialog open={props.open} title="Keyboard shortcuts" onClose={props.onClose}>
      <div class="shortcut-groups">
        {SHORTCUTS.map((group) => (
          <section class="shortcut-group" key={group.title}>
            <h3 class="shortcut-title">{group.title}</h3>
            {group.rows.map((row) => (
              <div class="shortcut-row" key={row.label}>
                <span>{row.label}</span>
                <span class="shortcut-keys">
                  {row.keys.map((k) => (
                    <span class="kbd" key={k}>
                      {k}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Dialog>
  );
}
