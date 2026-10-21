// Acesso à API do servidor. Todas as chamadas da interface passam por aqui.

import type { ApiErrorBody, MeResponse, Reservation, ReservationInput } from '../../shared/types.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly field?: string;
  constructor(status: number, message: string, field?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.field = field;
  }
}

function goToLogin(): never {
  const here = window.location.pathname + window.location.search;
  window.location.assign(`/auth/login?returnTo=${encodeURIComponent(here)}`);
  throw new ApiError(401, 'Sua sessão terminou. Entre de novo.');
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.method && init.method !== 'GET' ? { 'X-Requested-With': 'agendamento' } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'Sem conexão com o servidor. Verifique a internet e tente de novo.');
  }
  if (res.status === 401) goToLogin();
  const body = (await res.json().catch(() => ({}))) as T & Partial<ApiErrorBody>;
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Erro ${res.status}.`, body.field);
  return body;
}

export const api = {
  me: () => request<MeResponse>('/api/me'),

  listReservations: async (from: string, to: string) =>
    (await request<{ reservations: Reservation[] }>(
      `/api/reservations?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    )).reservations,

  searchReservations: async (q: string) =>
    (await request<{ reservations: Reservation[] }>(`/api/reservations?q=${encodeURIComponent(q)}`)).reservations,

  availability: (unit: string, start: string, end: string, signal?: AbortSignal) =>
    request<{ unit: string; free: number; total: number }>(
      `/api/availability?unit=${encodeURIComponent(unit)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
      { signal },
    ),

  createReservation: async (input: ReservationInput) =>
    (await request<{ reservation: Reservation }>('/api/reservations', {
      method: 'POST',
      body: JSON.stringify(input),
    })).reservation,

  cancelReservation: async (id: string) =>
    (await request<{ reservation: Reservation }>(`/api/reservations/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    })).reservation,

  registerReturn: async (id: string) =>
    (await request<{ reservation: Reservation }>(`/api/reservations/${encodeURIComponent(id)}/return`, {
      method: 'POST',
    })).reservation,

  logout: async () => {
    const { redirect } = await request<{ redirect: string }>('/auth/logout', { method: 'POST' });
    window.location.assign(redirect);
  },
};
