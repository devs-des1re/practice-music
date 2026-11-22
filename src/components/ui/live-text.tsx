export interface LiveTextProps {
  class: string;
  text: string;
  level?: string;
  on?: boolean;
}

export function LiveText(props: LiveTextProps) {
  return (
    <div class={props.class} data-level={props.level} data-on={props.on ? "true" : "false"}>
      {props.text}
    </div>
  );
}
