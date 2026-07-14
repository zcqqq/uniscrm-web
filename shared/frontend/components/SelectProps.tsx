import type { PropDefinition } from "../../../metadata/dataTypes";
import { t, type Locale } from "../../../metadata/locale";
import { Select } from "../ui/select";

interface SelectPropsProps {
  options: PropDefinition[];
  value: string;
  onChange: (propId: string) => void;
  locale?: Locale;
  placeholder?: string;
}

export function SelectProps({ options, value, onChange, locale = "en", placeholder }: SelectPropsProps) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder || (locale === "zh" ? "不分组" : "No grouping")}</option>
      {options.map((p) => (
        <option key={p.propId} value={p.propId}>{t(p.label, locale)}</option>
      ))}
    </Select>
  );
}
