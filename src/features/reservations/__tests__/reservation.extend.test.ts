/**
 * Práctica Integradora 2 - Extensión de reservaciones.
 *
 * Cada test lleva el ID del caso de prueba (CP-xx) diseñado en el PDF antes de
 * implementar la feature. La suite está dividida en tres niveles unitarios:
 *   1. validateExtensionEndTime  -> regla pura (sin BD).
 *   2. extendReservation         -> Service con el Model de Mongoose simulado.
 *   3. PATCH /:id/extend         -> Route con el Service simulado (traducción a HTTP),
 *      levantando la app en un puerto efímero y usando fetch() nativo de Node.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Types } from 'mongoose';
import { validateExtensionEndTime } from '../reservation.rules';

jest.mock('../reservation.model', () => ({
  Reservation: { findById: jest.fn(), find: jest.fn() }
}));

import { Reservation } from '../reservation.model';
import * as reservationService from '../reservation.service';
import reservationRoutes from '../reservation.routes';

const { extendReservation, ReservationError } = reservationService;

// Reloj fijo para que las pruebas sean reproducibles.
const NOW = new Date('2026-10-31T10:30:00.000Z');
const START = new Date('2026-10-31T10:00:00.000Z');
const CURRENT_END = new Date('2026-10-31T11:00:00.000Z');

const findByIdMock = Reservation.findById as unknown as jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const findMock = Reservation.find as unknown as jest.Mock<(...args: unknown[]) => Promise<unknown>>;

type FakeReservation = {
  _id: Types.ObjectId;
  parkingSpotId: Types.ObjectId;
  startTime: Date;
  endTime: Date;
  status: 'ACTIVE' | 'CANCELLED';
  save: jest.Mock<() => Promise<unknown>>;
};

const SPOT_ID = new Types.ObjectId();

function buildReservation(overrides: Partial<FakeReservation> = {}): FakeReservation {
  const reservation: FakeReservation = {
    _id: new Types.ObjectId(),
    parkingSpotId: SPOT_ID,
    startTime: START,
    endTime: CURRENT_END,
    status: 'ACTIVE',
    save: jest.fn(),
    ...overrides
  };
  reservation.save.mockImplementation(async () => reservation);
  return reservation;
}

async function expectReservationError(promise: Promise<unknown>, status: number) {
  await expect(promise).rejects.toBeInstanceOf(ReservationError);
  await expect(promise).rejects.toMatchObject({ status });
}

// ---------------------------------------------------------------------------
// 1. Regla pura
// ---------------------------------------------------------------------------
describe('validateExtensionEndTime (regla pura)', () => {
  test('CP-01 devuelve la nueva fecha cuando es posterior a la hora final actual', () => {
    // Arrange
    const newEndTime = '2026-10-31T12:00:00.000Z';

    // Act
    const result = validateExtensionEndTime(CURRENT_END, newEndTime, NOW);

    // Assert
    expect(result).toEqual(new Date(newEndTime));
  });

  test('CP-11 acepta una extensión de un solo minuto (límite inferior válido)', () => {
    const result = validateExtensionEndTime(CURRENT_END, '2026-10-31T11:01:00.000Z', NOW);

    expect(result).toEqual(new Date('2026-10-31T11:01:00.000Z'));
  });

  test('CP-12 rechaza una nueva hora final igual a la actual', () => {
    const result = validateExtensionEndTime(CURRENT_END, CURRENT_END.toISOString(), NOW);

    expect(result).toBeNull();
  });

  test('CP-05 rechaza una nueva hora final anterior a la actual', () => {
    const result = validateExtensionEndTime(CURRENT_END, '2026-10-31T10:45:00.000Z', NOW);

    expect(result).toBeNull();
  });

  test('CP-06 rechaza un texto que no es fecha', () => {
    const result = validateExtensionEndTime(CURRENT_END, 'mañana a las 5', NOW);

    expect(result).toBeNull();
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['número', 1793534400000],
    ['cadena vacía', ''],
    ['objeto', { endTime: '2026-10-31T12:00:00.000Z' }]
  ])('CP-07 rechaza una hora final de tipo %s', (_label, value) => {
    const result = validateExtensionEndTime(CURRENT_END, value, NOW);

    expect(result).toBeNull();
  });

  test('CP-04 rechaza extender una reservación cuya hora final ya ocurrió', () => {
    // Arrange: "ahora" es posterior a la hora final actual.
    const later = new Date('2026-10-31T11:30:00.000Z');

    // Act
    const result = validateExtensionEndTime(CURRENT_END, '2026-10-31T12:00:00.000Z', later);

    // Assert
    expect(result).toBeNull();
  });

  test('CP-13 rechaza cuando la hora final actual es exactamente "ahora"', () => {
    const result = validateExtensionEndTime(CURRENT_END, '2026-10-31T12:00:00.000Z', CURRENT_END);

    expect(result).toBeNull();
  });

  test('CP-14 acepta una fecha ISO con zona horaria distinta a UTC', () => {
    // 06:00 en Ciudad de México (UTC-6) = 12:00 UTC.
    const result = validateExtensionEndTime(CURRENT_END, '2026-10-31T06:00:00-06:00', NOW);

    expect(result?.toISOString()).toBe('2026-10-31T12:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// 2. Service (Model de Mongoose simulado)
// ---------------------------------------------------------------------------
describe('extendReservation (Service)', () => {
  beforeEach(() => {
    findByIdMock.mockReset();
    findMock.mockReset();
  });

  test('CP-01 actualiza endTime, persiste y devuelve la reservación', async () => {
    // Arrange
    const reservation = buildReservation();
    findByIdMock.mockResolvedValue(reservation);
    findMock.mockResolvedValue([]);
    const newEndTime = '2026-10-31T12:00:00.000Z';

    // Act
    const result = await extendReservation(reservation._id.toString(), newEndTime, NOW);

    // Assert
    expect(result).toBe(reservation);
    expect(reservation.endTime).toEqual(new Date(newEndTime));
    expect(reservation.startTime).toEqual(START);
    expect(reservation.status).toBe('ACTIVE');
    expect(reservation.save).toHaveBeenCalledTimes(1);
  });

  test('CP-01 busca conflictos solo en el mismo espacio, ACTIVE y excluyendo a la propia reservación', async () => {
    const reservation = buildReservation();
    findByIdMock.mockResolvedValue(reservation);
    findMock.mockResolvedValue([]);

    await extendReservation(reservation._id.toString(), '2026-10-31T12:00:00.000Z', NOW);

    expect(findMock).toHaveBeenCalledWith({
      _id: { $ne: reservation._id },
      parkingSpotId: SPOT_ID,
      status: 'ACTIVE',
      startTime: { $lt: new Date('2026-10-31T12:00:00.000Z') },
      endTime: { $gt: START }
    });
  });

  test('CP-02 responde 404 cuando la reservación no existe', async () => {
    findByIdMock.mockResolvedValue(null);

    await expectReservationError(
      extendReservation(new Types.ObjectId().toString(), '2026-10-31T12:00:00.000Z', NOW),
      404
    );
    expect(findMock).not.toHaveBeenCalled();
  });

  test('CP-03 responde 404 con un ID que no es un ObjectId válido, sin consultar la BD', async () => {
    await expectReservationError(extendReservation('abc123', '2026-10-31T12:00:00.000Z', NOW), 404);

    expect(findByIdMock).not.toHaveBeenCalled();
  });

  test('CP-08 responde 409 cuando la reservación está CANCELLED y no la modifica', async () => {
    const reservation = buildReservation({ status: 'CANCELLED' });
    findByIdMock.mockResolvedValue(reservation);

    await expectReservationError(
      extendReservation(reservation._id.toString(), '2026-10-31T12:00:00.000Z', NOW),
      409
    );
    expect(reservation.endTime).toEqual(CURRENT_END);
    expect(reservation.save).not.toHaveBeenCalled();
  });

  test('CP-04 responde 409 cuando la reservación ya terminó', async () => {
    const reservation = buildReservation();
    findByIdMock.mockResolvedValue(reservation);
    const afterEnd = new Date('2026-10-31T11:15:00.000Z');

    await expectReservationError(
      extendReservation(reservation._id.toString(), '2026-10-31T12:00:00.000Z', afterEnd),
      409
    );
    expect(reservation.save).not.toHaveBeenCalled();
  });

  test.each([
    ['anterior a la actual', '2026-10-31T10:45:00.000Z'],
    ['igual a la actual', '2026-10-31T11:00:00.000Z'],
    ['no es fecha', 'no-es-fecha'],
    ['ausente', undefined]
  ])('CP-05/06/07/12 responde 400 y no modifica cuando la nueva hora final es inválida (%s)', async (_label, value) => {
    const reservation = buildReservation();
    findByIdMock.mockResolvedValue(reservation);

    await expectReservationError(extendReservation(reservation._id.toString(), value, NOW), 400);
    expect(reservation.endTime).toEqual(CURRENT_END);
    expect(reservation.save).not.toHaveBeenCalled();
    expect(findMock).not.toHaveBeenCalled();
  });

  test('CP-09 responde 409 cuando la extensión traslapa otra reservación ACTIVE del mismo espacio', async () => {
    // Arrange: otra reservación 11:30-12:30 en el mismo espacio.
    const reservation = buildReservation();
    const other = buildReservation({
      startTime: new Date('2026-10-31T11:30:00.000Z'),
      endTime: new Date('2026-10-31T12:30:00.000Z')
    });
    findByIdMock.mockResolvedValue(reservation);
    findMock.mockResolvedValue([other]);

    // Act
    const promise = extendReservation(reservation._id.toString(), '2026-10-31T12:00:00.000Z', NOW);

    // Assert
    await expectReservationError(promise, 409);
    expect(reservation.endTime).toEqual(CURRENT_END);
    expect(reservation.save).not.toHaveBeenCalled();
  });

  test('CP-10 permite la extensión cuando termina exactamente cuando otra comienza (adyacentes)', async () => {
    const reservation = buildReservation();
    const next = buildReservation({
      startTime: new Date('2026-10-31T12:00:00.000Z'),
      endTime: new Date('2026-10-31T13:00:00.000Z')
    });
    findByIdMock.mockResolvedValue(reservation);
    findMock.mockResolvedValue([next]);

    const result = await extendReservation(reservation._id.toString(), '2026-10-31T12:00:00.000Z', NOW);

    expect(result.endTime).toEqual(new Date('2026-10-31T12:00:00.000Z'));
    expect(reservation.save).toHaveBeenCalledTimes(1);
  });

  test('CP-15 una reservación CANCELLED en el horario extendido no bloquea la extensión', async () => {
    const reservation = buildReservation();
    const cancelled = buildReservation({
      status: 'CANCELLED',
      startTime: new Date('2026-10-31T11:30:00.000Z'),
      endTime: new Date('2026-10-31T12:30:00.000Z')
    });
    findByIdMock.mockResolvedValue(reservation);
    findMock.mockResolvedValue([cancelled]);

    const result = await extendReservation(reservation._id.toString(), '2026-10-31T12:00:00.000Z', NOW);

    expect(result.endTime).toEqual(new Date('2026-10-31T12:00:00.000Z'));
    expect(reservation.save).toHaveBeenCalledTimes(1);
  });

  test('CP-16 la propia reservación no se cuenta como conflicto consigo misma', async () => {
    const reservation = buildReservation();
    findByIdMock.mockResolvedValue(reservation);
    // Aunque la consulta devolviera la misma reservación, no debe bloquear.
    findMock.mockResolvedValue([reservation]);

    const result = await extendReservation(reservation._id.toString(), '2026-10-31T12:00:00.000Z', NOW);

    expect(result.endTime).toEqual(new Date('2026-10-31T12:00:00.000Z'));
    expect(reservation.save).toHaveBeenCalledTimes(1);
  });

  test('CP-17 una reservación ACTIVE posterior que no traslapa no bloquea la extensión', async () => {
    const reservation = buildReservation();
    const later = buildReservation({
      startTime: new Date('2026-10-31T14:00:00.000Z'),
      endTime: new Date('2026-10-31T15:00:00.000Z')
    });
    findByIdMock.mockResolvedValue(reservation);
    findMock.mockResolvedValue([later]);

    const result = await extendReservation(reservation._id.toString(), '2026-10-31T13:00:00.000Z', NOW);

    expect(result.endTime).toEqual(new Date('2026-10-31T13:00:00.000Z'));
  });

  test('CP-18 detecta conflicto cuando la extensión cubre por completo otra reservación', async () => {
    const reservation = buildReservation();
    const inside = buildReservation({
      startTime: new Date('2026-10-31T12:00:00.000Z'),
      endTime: new Date('2026-10-31T12:30:00.000Z')
    });
    findByIdMock.mockResolvedValue(reservation);
    findMock.mockResolvedValue([inside]);

    await expectReservationError(
      extendReservation(reservation._id.toString(), '2026-10-31T14:00:00.000Z', NOW),
      409
    );
    expect(reservation.save).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Route: traducción del resultado del Service a HTTP
// ---------------------------------------------------------------------------
describe('PATCH /api/reservations/:id/extend (Route)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/reservations', reservationRoutes);

  let server: Server;
  let baseUrl: string;
  let extendSpy: jest.SpiedFunction<typeof reservationService.extendReservation>;

  beforeAll(async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    extendSpy = jest.spyOn(reservationService, 'extendReservation');
  });

  afterEach(() => {
    extendSpy.mockRestore();
  });

  function patchExtend(id: string, body?: unknown) {
    return fetch(`${baseUrl}/api/reservations/${id}/extend`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }

  test('CP-01 responde 200 con la reservación actualizada', async () => {
    // Arrange
    const updated = { _id: 'r1', endTime: '2026-10-31T12:00:00.000Z', status: 'ACTIVE' };
    extendSpy.mockResolvedValue(updated as never);

    // Act
    const response = await patchExtend('r1', { endTime: '2026-10-31T12:00:00.000Z' });

    // Assert
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(updated);
    expect(extendSpy).toHaveBeenCalledWith('r1', '2026-10-31T12:00:00.000Z');
  });

  test.each([
    [400, 'End time must be a valid date after the current end time'],
    [404, 'Reservation not found'],
    [409, 'Parking spot is not available for the extended time range']
  ])('traduce ReservationError(%i) al mismo código HTTP', async (status, message) => {
    extendSpy.mockRejectedValue(new ReservationError(status as 400 | 404 | 409, message));

    const response = await patchExtend('r1', { endTime: '2026-10-31T12:00:00.000Z' });

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ message });
  });

  test('CP-07 envía endTime undefined al Service cuando el body viene vacío', async () => {
    extendSpy.mockRejectedValue(new ReservationError(400, 'invalid'));

    const response = await patchExtend('r1');

    expect(response.status).toBe(400);
    expect(extendSpy).toHaveBeenCalledWith('r1', undefined);
  });

  test('responde 500 ante un error inesperado', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    extendSpy.mockRejectedValue(new Error('DB down'));

    const response = await patchExtend('r1', { endTime: '2026-10-31T12:00:00.000Z' });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: 'Could not extend reservation' });
    consoleSpy.mockRestore();
  });
});
