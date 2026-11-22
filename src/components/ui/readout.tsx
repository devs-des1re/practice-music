export interface ReadoutProps {
  label: string;
  value: string;
  size?: "default" | "display";
  title?: string;
}

export function Readout(props: ReadoutProps) {
  return (
    <div class="readout">
      <span class="readout-label">{props.label}</span>
      <span class="readout-value" data-size={props.size || "default"} title={props.title || props.value}>
        {props.value}
      </span>
    </div>
  );
}
