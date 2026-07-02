import { EventMetadata_X, PROPS_X } from "../../../metadata/x";
import { t, type Locale } from "../../../metadata/locale";

interface SelectPropsProps {
  eventType: string;
  value: string;
  onChange: (propId: string) => void;
  locale?: Locale;
  placeholder?: string;
}

export function SelectProps({ eventType, value, onChange, locale = "en", placeholder }: SelectPropsProps) {
  const meta = EventMetadata_X.find((e) => e.eventType === eventType);
  const eventPropIds = meta?.eventProps.map((p) => p.propId) || [];
  const options = eventPropIds
    .map((id) => PROPS_X.find((p) => p.propId === id))
    .filter(Boolean)
    .map((p) => ({ id: p!.propId, label: t(p!.label, locale) }));

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="border border-border rounded px-2 py-1.5 text-sm"
    >
      <option value="">{placeholder || (locale === "zh" ? "不分组" : "No grouping")}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>{o.label}</option>
      ))}
    </select>
  );
}
