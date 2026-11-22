export interface StatusDotProps {
  tone: "ok" | "warn" | "bad" | "idle";
  label?: string;
}

export function StatusDot(props: StatusDotProps) {
  return <span class="status-dot" data-tone={props.tone} role="img" aria-label={props.label || props.tone} />;
}
