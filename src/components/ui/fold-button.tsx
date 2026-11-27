export function FoldButton() {
  return (
    <button
      class="krate-button krate-button-ghost krate-button-icon krate-button-sm fold-button"
      type="button"
      data-fold="true"
      aria-label="Collapse or expand this panel"
      data-tip="Collapse or expand this panel"
    >
      <Icon name="lucide:chevron-down" />
      <Icon name="lucide:chevrons-up-down" />
    </button>
  );
}
