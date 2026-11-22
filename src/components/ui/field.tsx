export interface FieldProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  warning?: string;
  children?: any;
}

export function Field(props: FieldProps) {
  return (
    <div class="field">
      <label class="field-label" for={props.htmlFor}>
        {props.label}
      </label>
      {props.children}
      <p class="field-hint" showIf={!!props.hint}>
        {props.hint}
      </p>
      <p class="field-warn" showIf={!!props.warning}>
        {props.warning}
      </p>
    </div>
  );
}
