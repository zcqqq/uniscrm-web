export interface LocationConfig {
  id: string;
  label: string;
  language: string;
  shortCode: string;
  twitter?: { woeid: number };
}

export const LOCATIONS: LocationConfig[] = [
  { id: "global", label: "Global", language: "en", shortCode: "gl", twitter: { woeid: 1 } },
  { id: "china", label: "China", language: "zh", shortCode: "cn", twitter: { woeid: 23424781 } },
];

export const LOCATION_SHORT: Record<string, string> = Object.fromEntries(
  LOCATIONS.map((l) => [l.id, l.shortCode])
);
