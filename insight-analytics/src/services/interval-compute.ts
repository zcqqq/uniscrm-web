interface EventRecord {
  event_type: string;
  event_time: string;
}

/**
 * Sequential non-overlapping A→B pairing (Sensors Data pattern).
 * Events must be sorted by event_time ascending for a single profile.
 */
export function computeIntervals(
  events: EventRecord[],
  eventTypeA: string,
  eventTypeB: string
): number[] {
  const intervals: number[] = [];
  let waitingForB = false;
  let lastATime: number | null = null;

  for (const evt of events) {
    if (!waitingForB && evt.event_type === eventTypeA) {
      lastATime = new Date(evt.event_time).getTime();
      waitingForB = true;
    } else if (waitingForB && evt.event_type === eventTypeB) {
      const bTime = new Date(evt.event_time).getTime();
      if (lastATime !== null) {
        const intervalSeconds = (bTime - lastATime) / 1000;
        if (intervalSeconds >= 0) {
          intervals.push(intervalSeconds);
        }
      }
      waitingForB = false;
      lastATime = null;
    }
  }

  return intervals;
}
