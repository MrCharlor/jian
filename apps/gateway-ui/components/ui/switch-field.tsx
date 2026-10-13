'use client';

import { Switch } from './switch';

/** An on/off setting with its name and what it does, as Providers lists its switches. */
export function SwitchField({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="switch-field">
      <div className="min-w-0">
        <strong>{label}</strong>
        <p>{hint}</p>
      </div>
      <Switch
        label={`${label}: ${checked ? 'ligado' : 'desligado'}`}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
      />
    </div>
  );
}
