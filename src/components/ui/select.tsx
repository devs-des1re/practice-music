export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  id?: string;
  label?: string;
  value: string;
  options: SelectOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
}

export function Select(props: SelectProps) {
  return (
    <select
      class="krate-native-select"
      id={props.id}
      aria-label={props.label}
      disabled={props.disabled}
      onChange={(e: Event) => props.onChange((e.target as HTMLSelectElement).value)}
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled} selected={o.value === props.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
