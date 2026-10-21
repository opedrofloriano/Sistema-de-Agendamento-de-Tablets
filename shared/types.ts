// Tipos compartilhados entre o servidor e a interface.

export type ReservationStatus = 'confirmada' | 'cancelada' | 'devolvida';

export interface Reservation {
  id: string;
  title: string;
  /** Nome do professor responsável pela aula. */
  teacher: string;
  /** Id do usuário que criou a reserva (oid do Microsoft Entra ID). */
  ownerId: string;
  unit: string;
  className: string;
  quantity: number;
  /** Início no horário local da escola, formato AAAA-MM-DDTHH:MM:SS. */
  start: string;
  /** Término no horário local da escola, formato AAAA-MM-DDTHH:MM:SS. */
  end: string;
  status: ReservationStatus;
  notes: string;
  createdAt: string;
}

/** Dados que o formulário envia para criar uma reserva. */
export interface ReservationInput {
  title: string;
  /** Só é usado quando quem reserva é da coordenação; para professores vale o nome do login. */
  teacher: string;
  unit: string;
  className: string;
  quantity: number;
  /** AAAA-MM-DD */
  date: string;
  /** HH:MM */
  startTime: string;
  /** HH:MM */
  endTime: string;
  notes: string;
}

export interface ClassPeriod {
  id: string;
  label: string;
  start: string;
  end: string;
}

export interface TextLimits {
  title: number;
  teacher: number;
  className: number;
  notes: number;
}

/** Uma unidade da escola e o acervo de tablets que é só dela. */
export interface Unit {
  name: string;
  tablets: number;
}

/** Regras da escola. Vêm de config/escola.json no servidor. */
export interface AppConfig {
  /** Cada unidade tem o próprio acervo: reservas de uma não ocupam tablets da outra. */
  units: Unit[];
  periods: ClassPeriod[];
  /** Início do expediente, em minutos desde 00:00 (420 = 07:00). */
  dayStartMinutes: number;
  /** Fim do expediente, em minutos desde 00:00 (1100 = 18:20). */
  dayEndMinutes: number;
  minDurationMinutes: number;
  timezone: string;
  limits: TextLimits;
}

export type UserRole = 'professor' | 'coordenacao';

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

export interface MeResponse {
  user: User;
  config: AppConfig;
  /** entra: login Microsoft; dev: login de teste no servidor; demo: arquivo HTML sem servidor. */
  authMode: 'entra' | 'dev' | 'demo';
}

export interface ApiErrorBody {
  error: string;
  field?: string;
}
