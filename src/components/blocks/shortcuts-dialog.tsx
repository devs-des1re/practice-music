import { createSignal, onMount, onCleanup } from "@krate/runtime";
import { Dialog } from "../ui/dialog";
import { chordOf, commandFor, helpGroups, pressedCommand, type HelpGroup } from "../../lib/keymap";

export interface ShortcutsHostProps {
  scope: string;
}

const PAGE_LINKS: Record<string, string> = {
  "app.workspace": '.topbar a[href="/"]',
  "app.drums": '.topbar a[href="/drums"]',
  "app.latency": '.topbar a[href="/latency"]',
  "app.settings": '.topbar a[href="/settings"]',
};

export function ShortcutsHost(props: ShortcutsHostProps) {
  const [helpShown, setHelpShown] = createSignal(false);
  const [helpList, setHelpList] = createSignal<HelpGroup[]>([]);

  onMount(() => {
    const scope = props.scope;
    setHelpList(helpGroups(scope));
    const toggle = () => {
      setHelpShown(!helpShown());
      if (!helpShown()) return;
      window.setTimeout(() => {
        const body = document.querySelector('.dialog-scrim[data-on="true"] .dialog-body') as HTMLElement | null;
        body?.focus();
      }, 50);
    };
    const onKey = (e: KeyboardEvent) => {
      if (helpShown() && commandFor(chordOf(e), scope)?.id === "app.help") {
        e.preventDefault();
        setHelpShown(false);
        return;
      }
      const hit = pressedCommand(e, scope, "app");
      if (!hit) return;
      if (hit.id === "app.help") {
        toggle();
        return;
      }
      (document.querySelector(PAGE_LINKS[hit.id]) as HTMLElement | null)?.click();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pm:help", toggle);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pm:help", toggle);
    });
  });

  return (
    <Dialog open={helpShown()} title="Keyboard shortcuts" onClose={() => setHelpShown(false)}>
      <div class="shortcut-groups">
        {helpList().map((group) => (
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
