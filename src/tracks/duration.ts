export function durationMillisecondsToClientSeconds(durationMs?: number | null) {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }

  return Math.max(0, Math.round(durationMs / 1000));
}

export function trackDurationToMilliseconds(duration?: number | null) {
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    return null;
  }

  const rounded = Math.round(duration);
  return rounded >= 30_000 ? rounded : rounded * 1000;
}

export function trackDurationToClientSeconds(duration?: number | null) {
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    return 0;
  }

  const rounded = Math.round(duration);
  return rounded >= 30_000 ? Math.round(rounded / 1000) : rounded;
}
