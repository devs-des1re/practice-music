export interface SectionProps {
  title: string;
  open: boolean;
  onToggle: () => void;
  switchLabel?: string;
  switchOn?: boolean;
  onSwitch?: (on: boolean) => void;
  children?: any;
}

export function Section(props: SectionProps) {
  return (
    <section class="inspector-section" data-open={props.open ? "true" : "false"}>
      <div class="section-head">
        <button class="section-toggle" type="button" aria-expanded={props.open} onClick={props.onToggle}>
          <Icon name="lucide:chevron-down" />
          <span class="section-title">{props.title}</span>
        </button>
        <label class="section-switch" showIf={!!props.onSwitch}>
          <input
            type="checkbox"
            checked={!!props.switchOn}
            onChange={(e: Event) => {
              if (props.onSwitch) props.onSwitch((e.target as HTMLInputElement).checked);
            }}
          />
          <span>{props.switchLabel || "On"}</span>
        </label>
      </div>
      <div class="section-body">{props.children}</div>
    </section>
  );
}
