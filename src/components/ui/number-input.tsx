import { createEffect, onMount } from "@krate/runtime";
import { clampNumber } from "../../lib/numbers";

export interface NumberInputProps {
  id: string;
  class: string;
  label: string;
  value: number;
  min: number;
  max: number;
  decimals: number;
  onCommit: (value: number) => void;
}

export function NumberInput(props: NumberInputProps) {
  const show = (value: number) => {
    const el = document.getElementById(props.id) as HTMLInputElement | null;
    if (el && document.activeElement !== el) el.value = String(value);
  };

  createEffect(() => {
    const value = props.value;
    if (typeof document !== "undefined") show(value);
  });

  onMount(() => show(props.value));

  const commit = (el: HTMLInputElement) => {
    const next = clampNumber(el.value, props.min, props.max, props.decimals);
    if (next === null) {
      el.value = String(props.value);
      return;
    }
    el.value = String(next);
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
      onFocus={(e: FocusEvent) => (e.target as HTMLInputElement).select()}
      onBlur={(e: FocusEvent) => commit(e.target as HTMLInputElement)}
      onKeyDown={(e: KeyboardEvent) => {
        const el = e.target as HTMLInputElement;
        if (e.key === "Enter") {
          e.preventDefault();
          el.blur();
        } else if (e.key === "Escape") {
          el.value = String(props.value);
          el.blur();
        }
      }}
    />
  );
}
