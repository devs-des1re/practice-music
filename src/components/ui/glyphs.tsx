export interface GlyphProps {
  on: boolean;
  offLabel?: string;
  onLabel?: string;
}

export function PlayGlyph(props: GlyphProps) {
  return (
    <span class="glyph" data-on={props.on ? "true" : "false"}>
      <span class="glyph-off">
        <Icon name="lucide:play" />
        {props.offLabel}
      </span>
      <span class="glyph-on">
        <Icon name="lucide:pause" />
        {props.onLabel}
      </span>
    </span>
  );
}

export function RunGlyph(props: GlyphProps) {
  return (
    <span class="glyph" data-on={props.on ? "true" : "false"}>
      <span class="glyph-off">
        <Icon name="lucide:play" />
        {props.offLabel}
      </span>
      <span class="glyph-on">
        <Icon name="lucide:square" />
        {props.onLabel}
      </span>
    </span>
  );
}
