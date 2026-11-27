import { createEffect, onMount } from "@krate/runtime";
import { parseLevel } from "../../lib/numbers";
import { formatDb } from "../../lib/mixer";

export interface NumberInputProps {
  id: string;
  class: string;
  label: string;
  value: number;
  min: number;
  max: number;
  decimals: number;
  unit?: string;
  tip?: string;
  disabled?: boolean;
  onCommit: (value: number) => void;
}

function numberText(value: number, unit: string | undefined): string {
  if (unit === "db") return formatDb(value);
  if (unit === "percent") return value + "%";
  return String(value);
}

export function NumberInput(props: NumberInputProps) {
  const show = (value: number) => {
    const el = document.getElementById(props.id) as HTMLInputElement | null;
    if (el && document.activeElement !== el) el.value = numberText(value, props.unit);
  };

  createEffect(() => {
    const value = props.value;
    if (typeof document !== "undefined") show(value);
  });

  onMount(() => show(props.value));

  const commit = (el: HTMLInputElement) => {
    const current = numberText(props.value, props.unit);
    const next = el.value === current ? null : parseLevel(el.value, props.min, props.max, props.decimals);
    if (next === null) {
      el.value = current;
      return;
    }
    el.value = numberText(next, props.unit);
    if (next !== props.value) props.onCommit(next);
  };

  return (
    <input
      id={props.id}
      class={props.class}
      type="text"
      inputMode="decimal"
      autocomplete="off"
      aria-label={props.label}
      data-tip={props.tip}
      disabled={props.disabled}
      onFocus={(e: FocusEvent) => (e.target as HTMLInputElement).select()}
      onBlur={(e: FocusEvent) => commit(e.target as HTMLInputElement)}
      onKeyDown={(e: KeyboardEvent) => {
        const el = e.target as HTMLInputElement;
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          el.blur();
        } else if (e.key === "Escape") {
          e.stopPropagation();
          el.value = numberText(props.value, props.unit);
          el.blur();
        }
      }}
    />
  );
}
