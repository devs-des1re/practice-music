export interface NoticeProps {
  tone?: "ok" | "warn" | "bad" | "info";
  title?: string;
  text?: string;
  children?: any;
}

export function Notice(props: NoticeProps) {
  return (
    <div class="notice" data-tone={props.tone || "info"} role={props.tone === "bad" ? "alert" : "status"}>
      <span class="notice-icon notice-icon-info">
        <Icon name="lucide:info" />
      </span>
      <span class="notice-icon notice-icon-ok">
        <Icon name="lucide:circle-check" />
      </span>
      <span class="notice-icon notice-icon-warn">
        <Icon name="lucide:triangle-alert" />
      </span>
      <span class="notice-icon notice-icon-bad">
        <Icon name="lucide:circle-alert" />
      </span>
      <div class="notice-body">
        <span class="notice-title" showIf={!!props.title}>
          {props.title}
        </span>
        <span class="notice-text">
          {props.text}
          {props.children}
        </span>
      </div>
    </div>
  );
}
