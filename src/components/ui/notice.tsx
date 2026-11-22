export interface NoticeProps {
  tone?: "ok" | "warn" | "bad" | "info";
  title: string;
  text?: string;
  children?: any;
}

export function Notice(props: NoticeProps) {
  return (
    <div class="notice" data-tone={props.tone || "info"} role={props.tone === "bad" ? "alert" : "status"}>
      <div class="notice-body">
        <span class="notice-title">{props.title}</span>
        <span class="notice-text">
          {props.text}
          {props.children}
        </span>
      </div>
    </div>
  );
}
