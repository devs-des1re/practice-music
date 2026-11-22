export interface TopbarProps {
  onMenu: () => void;
}

export function Topbar(props: TopbarProps) {
  return (
    <header class="topbar">
      <button
        class="krate-button krate-button-ghost krate-button-icon"
        type="button"
        aria-label="Open navigation"
        onClick={props.onMenu}
      >
        <Icon name="lucide:menu" />
      </button>
      <div class="brand">
        <span class="brand-mark">PM</span>
        <span class="brand-name">PracticeMusic</span>
      </div>
    </header>
  );
}
