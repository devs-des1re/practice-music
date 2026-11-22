export function Panel(props: { children?: any }) {
  return <section class="panel">{props.children}</section>;
}

export function PanelHead(props: { title: string; children?: any }) {
  return (
    <header class="panel-head">
      <h2 class="panel-title">{props.title}</h2>
      {props.children}
    </header>
  );
}

export function PanelBody(props: { children?: any }) {
  return <div class="panel-body">{props.children}</div>;
}
