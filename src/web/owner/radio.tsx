// A radio choice as a full row: the radio and its words side by side, with the
// whole row tappable. Used wherever the owner picks one of a few plain options.
export function RadioRow({
  name,
  value,
  checked,
  onChange,
  title,
  detail,
  disabled = false,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  title: string;
  detail?: string;
  disabled?: boolean;
}) {
  return (
    <label className={checked ? "radio-row selected" : "radio-row"}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span className="radio-text">
        <span className="radio-title">{title}</span>
        {detail ? <span className="radio-detail">{detail}</span> : null}
      </span>
    </label>
  );
}
