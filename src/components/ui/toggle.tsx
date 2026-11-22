export interface ToggleProps {
  id?: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function Toggle(props: ToggleProps) {
  return (
    <div class="toggle-row">
      <div class="toggle-text">
        <label class="field-label" for={props.id}>
          {props.label}
        </label>
        <span class="field-hint" showIf={!!props.hint}>
          {props.hint}
        </span>
      </div>
      <span class="toggle">
        <input
          id={props.id}
          type="checkbox"
          role="switch"
          checked={props.checked}
          onChange={(e: Event) => props.onChange((e.target as HTMLInputElement).checked)}
        />
        <span class="toggle-track" />
        <span class="toggle-thumb" />
      </span>
    </div>
  );
}
