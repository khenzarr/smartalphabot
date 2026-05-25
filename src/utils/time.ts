export function ageSeconds(from: Date | undefined, now = new Date()): number | undefined {
  if (!from) return undefined;
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1000));
}
