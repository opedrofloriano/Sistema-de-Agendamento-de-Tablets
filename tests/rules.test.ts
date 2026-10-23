import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG, busiestByUnit, displayStatus, freeTablets, peakUsage, validateReservation } from '../shared/rules.ts';
import type { Reservation, ReservationInput } from '../shared/types.ts';

process.env.TZ = 'America/Sao_Paulo';

const r = (
  id: string,
  start: string,
  end: string,
  quantity: number,
  status: Reservation['status'] = 'confirmada',
  unit = 'Castelo I',
) => ({
  id,
  unit,
  start: `2026-10-21T${start}:00`,
  end: `2026-10-21T${end}:00`,
  quantity,
  status,
});

const input = (over: Partial<ReservationInput> = {}): ReservationInput => ({
  title: 'Leitura',
  teacher: 'Ana',
  unit: 'Castelo I',
  className: '',
  quantity: 10,
  date: '2026-10-21',
  startTime: '08:40',
  endTime: '09:30',
  notes: '',
  ...over,
});

const NOW = new Date(2026, 9, 20, 10, 0);
const at = (h: number, m = 0) => new Date(2026, 9, 21, h, m);

test('soma reservas que se sobrepõem e ignora as que só encostam', () => {
  const list = [r('a', '07:50', '09:30', 15), r('b', '08:40', '10:40', 15), r('c', '10:40', '11:30', 10)];
  assert.equal(peakUsage(list, at(7), at(12)), 30);
  assert.equal(peakUsage(list, at(9, 30), at(10, 40)), 15);
  // b termina 10:40 e c começa 10:40: não contam juntas.
  assert.equal(peakUsage(list, at(10, 0), at(11, 0)), 15);
});

test('cada unidade tem o próprio acervo: reservas de uma não ocupam a outra', () => {
  const castelo = [r('a', '08:00', '09:00', 30, 'confirmada', 'Castelo II')];
  assert.equal(freeTablets(castelo, 'Castelo II', at(8), at(9), DEFAULT_CONFIG), 0);
  assert.equal(freeTablets(castelo, 'Castelo I', at(8), at(9), DEFAULT_CONFIG), 30);
  // Castelo I pode reservar os 30 dela mesmo com o Castelo II lotado.
  const res = validateReservation(input({ startTime: '08:00', endTime: '09:00', quantity: 30 }), castelo, NOW, DEFAULT_CONFIG);
  assert.equal(res.ok, true);
  const blocked = validateReservation(
    input({ unit: 'Castelo II', startTime: '08:00', endTime: '09:00', quantity: 1 }),
    castelo,
    NOW,
    DEFAULT_CONFIG,
  );
  assert.equal(blocked.ok, false);
  assert.match(!blocked.ok ? blocked.error : '', /Todos os tablets da unidade Castelo II/);
});

test('o acervo de cada unidade pode ter tamanho diferente', () => {
  const cfg = { ...DEFAULT_CONFIG, units: [{ name: 'Castelo II', tablets: 30 }, { name: 'Castelo I', tablets: 20 }] };
  const tooMany = validateReservation(input({ quantity: 21 }), [], NOW, cfg);
  assert.equal(!tooMany.ok && tooMany.field, 'quantity');
  assert.match(!tooMany.ok ? tooMany.error : '', /entre 1 e 20/);
  assert.equal(validateReservation(input({ unit: 'Castelo II', quantity: 21 }), [], NOW, cfg).ok, true);
});

test('pico da semana é calculado por unidade', () => {
  const list = [
    r('a', '08:00', '09:00', 30, 'confirmada', 'Castelo II'),
    r('b', '08:00', '09:00', 12, 'confirmada', 'Castelo I'),
  ];
  const peaks = busiestByUnit(list, new Date(2026, 9, 19), new Date(2026, 9, 24), DEFAULT_CONFIG);
  assert.deepEqual(
    peaks.map((p) => [p.unit, p.quantity, p.tablets]),
    [
      ['Castelo I', 12, 30],
      ['Castelo II', 30, 30],
    ],
  );
});

test('reservas canceladas e devolvidas não ocupam tablets', () => {
  const list = [r('a', '08:00', '09:00', 20, 'cancelada'), r('b', '08:00', '09:00', 20, 'devolvida')];
  assert.equal(peakUsage(list, at(8), at(9)), 0);
});

test('recusa quando faltaria tablet em qualquer minuto do intervalo', () => {
  const list = [r('a', '07:50', '09:30', 15), r('b', '08:40', '10:40', 15)];
  const res = validateReservation(input({ startTime: '09:00', endTime: '09:20', quantity: 1 }), list, NOW, DEFAULT_CONFIG);
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.conflict, true);
  assert.match(!res.ok ? res.error : '', /Todos os tablets/);
});

test('informa quantos tablets ainda cabem', () => {
  const list = [r('a', '08:00', '09:00', 25)];
  const res = validateReservation(input({ startTime: '08:30', endTime: '09:30', quantity: 6 }), list, NOW, DEFAULT_CONFIG);
  assert.equal(res.ok, false);
  assert.match(!res.ok ? res.error : '', /apenas 5 tablets livres da unidade Castelo I/);
  assert.equal(validateReservation(input({ startTime: '08:30', endTime: '09:30', quantity: 5 }), list, NOW, DEFAULT_CONFIG).ok, true);
});

test('valida data, horário e campos', () => {
  const cases: [Partial<ReservationInput>, string][] = [
    [{ title: '  ' }, 'title'],
    [{ unit: 'Outra' }, 'unit'],
    [{ quantity: 0 }, 'quantity'],
    [{ quantity: 31 }, 'quantity'],
    [{ quantity: 2.5 }, 'quantity'],
    [{ date: '2026-10-24' }, 'date'], // sábado
    [{ date: '2026-10-19' }, 'date'], // já passou
    [{ date: '2026-10-20', startTime: '09:00', endTime: '09:50' }, 'startTime'], // hoje, já começou
    [{ startTime: '10:00', endTime: '09:00' }, 'endTime'],
    [{ startTime: '10:00', endTime: '10:10' }, 'endTime'], // menos de 15 min
    [{ startTime: '06:30', endTime: '07:30' }, 'startTime'],
    [{ startTime: '18:30', endTime: '19:30' }, 'startTime'],
    [{ startTime: '17:30', endTime: '18:30' }, 'startTime'], // passa das 18:20
    [{ date: '2026-02-30' }, 'date'],
  ];
  for (const [over, field] of cases) {
    const res = validateReservation(input(over), [], NOW, DEFAULT_CONFIG);
    assert.equal(res.ok, false, JSON.stringify(over));
    assert.equal(!res.ok && res.field, field, JSON.stringify(over));
  }
});

test('o último horário de aula (17:30–18:20) cabe no expediente', () => {
  assert.equal(validateReservation(input({ startTime: '17:30', endTime: '18:20' }), [], NOW, DEFAULT_CONFIG).ok, true);
  assert.equal(DEFAULT_CONFIG.dayEndMinutes, 18 * 60 + 20);
});

test('situação muda com o horário', () => {
  const res = { status: 'confirmada' as const, start: '2026-10-21T08:00:00', end: '2026-10-21T09:00:00' };
  assert.equal(displayStatus(res, at(7)), 'agendada');
  assert.equal(displayStatus(res, at(8, 30)), 'em-andamento');
  assert.equal(displayStatus(res, at(9, 30)), 'aguardando-devolucao');
  assert.equal(displayStatus({ ...res, status: 'devolvida' }, at(9, 30)), 'devolvida');
});
