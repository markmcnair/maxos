/**
 * Parse a human time string into a Unix timestamp (ms).
 * Supports: "9:57pm", "9:57 PM", "21:57", "14:30"
 * Rolls to tomorrow if the time has already passed today.
 * Returns null if the format is unrecognized.
 */
export function parseTimeToTimestamp(time: string): number | null {
  const now = new Date();

  // Try "9:57pm", "9:57PM", "9:57 pm"
  const ampmMatch = time.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (ampmMatch) {
    let hours = parseInt(ampmMatch[1], 10);
    const minutes = parseInt(ampmMatch[2], 10);
    const isPM = ampmMatch[3].toLowerCase() === "pm";
    if (isPM && hours !== 12) hours += 12;
    if (!isPM && hours === 12) hours = 0;
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    return target.getTime();
  }

  // Try "21:57", "14:30"
  const militaryMatch = time.match(/^(\d{1,2}):(\d{2})$/);
  if (militaryMatch) {
    const hours = parseInt(militaryMatch[1], 10);
    const minutes = parseInt(militaryMatch[2], 10);
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      const target = new Date(now);
      target.setHours(hours, minutes, 0, 0);
      if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
      return target.getTime();
    }
  }

  return null;
}
