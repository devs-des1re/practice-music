import { NumberInput } from "./number-input";

export interface LevelRowProps {
  id: string;
  label: string;
  ariaLabel: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onInput: (value: number) => void;
  onReset?: () => void;
}

export function LevelRow(props: LevelRowProps) {
  return (
    <div class="param-row">
      <span class="param-row-label">{props.label}</span>
      <input
        class="range"
        type="range"
        min={String(props.min)}
        max={String(props.max)}
        step={String(props.step)}
        aria-label={props.ariaLabel}
        value={String(props.value)}
        onInput={(e: Event) => props.onInput(Number((e.target as HTMLInputElement).value))}
        onDoubleClick={() => {
          if (props.onReset) props.onReset();
        }}
      />
      <NumberInput
        id={props.id}
        class="param-row-value level-input mono"
        label={props.ariaLabel + " in dB"}
        unit="db"
        value={props.value}
        min={props.min}
        max={props.max}
        decimals={1}
        onCommit={(v) => props.onInput(v)}
      />
    </div>
  );
}
