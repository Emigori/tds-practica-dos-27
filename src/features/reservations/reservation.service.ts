import { isValidObjectId } from 'mongoose';
import { ParkingSpot } from '../parking-spots/parking-spot.model';
import { Reservation } from './reservation.model';
import {
  canReserveSpot,
  hasTimeConflict,
  validateExtensionEndTime,
  validateReservationPeriod
} from './reservation.rules';

export class ReservationError extends Error {
  constructor(public status: 400 | 404 | 409, message: string) {
    super(message);
  }
}

export async function getReservations() {
  return Reservation.find().populate('parkingSpotId', 'number').sort({ startTime: -1 });
}

export async function createReservation(input: {
  parkingSpotId: unknown;
  startTime: unknown;
  endTime: unknown;
}) {
  if (typeof input.parkingSpotId !== 'string' || !isValidObjectId(input.parkingSpotId)) {
    throw new ReservationError(400, 'Invalid parking spot ID');
  }

  const period = validateReservationPeriod(input.startTime, input.endTime);
  if (!period) {
    throw new ReservationError(400, 'Start time must be before end time');
  }

  const spot = await ParkingSpot.findById(input.parkingSpotId);
  if (!spot) {
    throw new ReservationError(404, 'Parking spot not found');
  }

  if (!spot.active) {
    throw new ReservationError(409, 'Parking spot is not active');
  }

  const overlappingReservations = await Reservation.find({
    parkingSpotId: spot._id,
    status: 'ACTIVE',
    startTime: { $lt: period.end },
    endTime: { $gt: period.start }
  });

  const hasConflict = overlappingReservations.some((reservation) =>
    hasTimeConflict(period.start, period.end, reservation.startTime, reservation.endTime)
  );

  if (!canReserveSpot(spot.active, hasConflict)) {
    throw new ReservationError(409, 'Parking spot is not available for this time range');
  }

  return Reservation.create({
    parkingSpotId: spot._id,
    startTime: period.start,
    endTime: period.end,
    status: 'ACTIVE'
  });
}

export async function cancelReservation(id: string) {
  if (!isValidObjectId(id)) {
    return null;
  }

  return Reservation.findByIdAndUpdate(id, { status: 'CANCELLED' }, { new: true });
}

export async function extendReservation(id: string, endTime: unknown, now: Date = new Date()) {
  // 1. Locate the reservation. A malformed ID can never be found.
  if (!isValidObjectId(id)) {
    throw new ReservationError(404, 'Reservation not found');
  }

  const reservation = await Reservation.findById(id);
  if (!reservation) {
    throw new ReservationError(404, 'Reservation not found');
  }

  // 2. Check that the current state allows an extension.
  if (reservation.status !== 'ACTIVE') {
    throw new ReservationError(409, 'Only active reservations can be extended');
  }

  if (reservation.endTime <= now) {
    throw new ReservationError(409, 'Reservation has already ended');
  }

  // 3. Validate the requested end time with the pure rule.
  const newEnd = validateExtensionEndTime(reservation.endTime, endTime, now);
  if (!newEnd) {
    throw new ReservationError(400, 'End time must be a valid date after the current end time');
  }

  // 4. Look for other ACTIVE reservations of the same spot that overlap the
  //    extended period. The reservation itself and CANCELLED ones are excluded.
  const candidates = await Reservation.find({
    _id: { $ne: reservation._id },
    parkingSpotId: reservation.parkingSpotId,
    status: 'ACTIVE',
    startTime: { $lt: newEnd },
    endTime: { $gt: reservation.startTime }
  });

  const hasConflict = candidates.some(
    (other) =>
      !other._id.equals(reservation._id) &&
      other.status === 'ACTIVE' &&
      hasTimeConflict(reservation.startTime, newEnd, other.startTime, other.endTime)
  );

  if (hasConflict) {
    throw new ReservationError(409, 'Parking spot is not available for the extended time range');
  }

  // 5. Persist only the new end time and return the updated reservation.
  reservation.endTime = newEnd;
  return reservation.save();
}
