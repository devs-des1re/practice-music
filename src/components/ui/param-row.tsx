export interface ParamRowProps {
  label: string;
  ariaLabel: string;
  min: number;
  max: number;
  step: number;
  value: number;
  text: string;
  disabled?: boolean;
  onInput: (value: number) => void;
  onReset?: () => void;
}

export function ParamRow(props: ParamRowProps) {
  return (
    <label class="param-row">
      <span class="param-row-label">{props.label}</span>
      <input
        class="range"
        type="range"
        min={String(props.min)}
        max={String(props.max)}
        step={String(props.step)}
        aria-label={props.ariaLabel}
        disabled={props.disabled}
        value={String(props.value)}
        onInput={(e: Event) => props.onInput(Number((e.target as HTMLInputElement).value))}
        onDoubleClick={() => {
          if (props.onReset) props.onReset();
        }}
      />
      <span class="param-row-value mono">{props.text}</span>
    </label>
  );
}
