export interface FaderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  marks: number[];
  disabled?: boolean;
  onInput: (value: number) => void;
  onReset?: () => void;
}

function markText(db: number): string {
  if (db <= -60) return "off";
  if (db > 0) return "+" + db;
  return String(db);
}

export function Fader(props: FaderProps) {
  return (
    <div class="fader">
      <div class="fader-scale" aria-hidden="true">
        {props.marks.map((m) => (
          <span class="fader-mark" key={m} style={"--p:" + (props.max - m) / (props.max - props.min)}>
            {markText(m)}
          </span>
        ))}
      </div>
      <input
        class="fader-input"
        type="range"
        min={String(props.min)}
        max={String(props.max)}
        step={String(props.step)}
        aria-label={props.label}
        data-tip={props.label + ". Double-click to reset."}
        disabled={props.disabled}
        value={String(props.value)}
        onInput={(e: Event) => props.onInput(Number((e.target as HTMLInputElement).value))}
        onDoubleClick={() => {
          if (props.onReset) props.onReset();
        }}
      />
    </div>
  );
}
