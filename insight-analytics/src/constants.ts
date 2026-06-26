export const BUCKETS = [
  { label: "0-1min", rangeStart: 0, rangeEnd: 60 },
  { label: "1-5min", rangeStart: 60, rangeEnd: 300 },
  { label: "5-30min", rangeStart: 300, rangeEnd: 1800 },
  { label: "30min-1h", rangeStart: 1800, rangeEnd: 3600 },
  { label: "1-6h", rangeStart: 3600, rangeEnd: 21600 },
  { label: "6-24h", rangeStart: 21600, rangeEnd: 86400 },
  { label: "1-3d", rangeStart: 86400, rangeEnd: 259200 },
  { label: "3-7d", rangeStart: 259200, rangeEnd: 604800 },
  { label: "7-14d", rangeStart: 604800, rangeEnd: 1209600 },
  { label: "14-30d", rangeStart: 1209600, rangeEnd: 2592000 },
  { label: "30d+", rangeStart: 2592000, rangeEnd: Infinity },
];

export const PROFILE_BATCH_SIZE = 200;
export const MAX_PROFILES_SYNC = 10000;
