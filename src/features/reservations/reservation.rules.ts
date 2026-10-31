export function validateReservationPeriod(startTime: unknown, endTime: unknown) {
  if (typeof startTime !== 'string' || typeof endTime !== 'string') {
    return null;
  }

  const start = new Date(startTime);
  const end = new Date(endTime);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    return null;
  }

  return { start, end };
}

export function hasTimeConflict(
  newStart: Date,
  newEnd: Date,
  existingStart: Date,
  existingEnd: Date
) {
  return newStart < existingEnd && newEnd > existingStart;
}

export function canReserveSpot(active: boolean, hasConflict: boolean) {
  return active && !hasConflict;
}

export function validateExtensionEndTime(
  currentEnd: Date,
  newEndTime: unknown,
  now: Date
): Date | null {
  // The new end time must arrive as a date-time string (ISO 8601 from the API).
  if (typeof newEndTime !== 'string' || newEndTime.trim() === '') {
    return null;
  }

  const newEnd = new Date(newEndTime);
  if (Number.isNaN(newEnd.getTime())) {
    return null;
  }

  // A reservation whose end time already happened can no longer be extended.
  if (currentEnd <= now) {
    return null;
  }

  // An extension must be strictly later than the current end time.
  if (newEnd <= currentEnd) {
    return null;
  }

  return newEnd;
}
