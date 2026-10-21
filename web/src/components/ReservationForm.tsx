import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { combine, formatLongDate, isValidDate, tabletsFor, toDateKey, toLocalIso } from '../../../shared/rules.ts';
import type { AppConfig, ReservationInput, User } from '../../../shared/types.ts';
import { ApiError, api } from '../api.ts';
import { useDebounced } from '../hooks.ts';
import { CloseIcon } from '../icons.tsx';
import { Modal } from './Modal.tsx';

interface ReservationFormProps {
  config: AppConfig;
  user: User;
  initialDate: Date;
  initialStartTime: string;
  initialEndTime: string;
  initialUnit: string;
  onClose: () => void;
  onSave: (input: ReservationInput) => Promise<void>;
}

type Availability =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; free: number; total: number; unit: string; day: Date }
  | { state: 'error' };

export function ReservationForm(props: ReservationFormProps) {
  const { config, user } = props;
  const isCoordinator = user.role === 'coordenacao';
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;
  const formRef = useRef<HTMLFormElement>(null);

  const [form, setForm] = useState<ReservationInput>(() => ({
    title: '',
    teacher: user.name,
    unit: props.initialUnit,
    className: '',
    quantity: 10,
    date: toDateKey(props.initialDate),
    startTime: props.initialStartTime,
    endTime: props.initialEndTime,
    notes: '',
  }));
  const [quantityText, setQuantityText] = useState('10');
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [availability, setAvailability] = useState<Availability>({ state: 'idle' });

  const set = <K extends keyof ReservationInput>(field: K, value: ReservationInput[K]) => {
    setForm((f) => ({ ...f, [field]: value }));
    // Mudar unidade, data, horário ou quantidade muda a disponibilidade: o aviso anterior deixa de valer.
    const affectsAvailability = ['unit', 'date', 'startTime', 'endTime', 'quantity'].includes(field);
    if (error && (error.field === field || (affectsAvailability && error.field === 'quantity'))) setError(null);
  };

  const periodId =
    config.periods.find((p) => p.start === form.startTime && p.end === form.endTime)?.id ?? 'custom';

  const start = combine(form.date, form.startTime);
  const end = combine(form.date, form.endTime);
  const timesValid = isValidDate(start) && isValidDate(end);
  const endBeforeStart = timesValid && end <= start;

  const unitTablets = tabletsFor(config, form.unit);

  // Pergunta ao servidor quantos tablets da unidade estão livres no intervalo escolhido.
  const range = useDebounced(
    timesValid && !endBeforeStart ? `${form.unit}|${toLocalIso(start)}|${toLocalIso(end)}` : '',
    250,
  );
  useEffect(() => {
    if (!range) {
      setAvailability({ state: 'idle' });
      return;
    }
    const [unit, s, e] = range.split('|');
    const controller = new AbortController();
    setAvailability({ state: 'loading' });
    api
      .availability(unit, s, e, controller.signal)
      .then((r) =>
        setAvailability({ state: 'ready', free: r.free, total: r.total, unit, day: combine(s.slice(0, 10), '00:00') }),
      )
      .catch(() => {
        if (!controller.signal.aborted) setAvailability({ state: 'error' });
      });
    return () => controller.abort();
  }, [range]);

  // Enquanto a resposta da unidade nova não chega, não mostra o número da unidade anterior.
  const ready = availability.state === 'ready' && availability.unit === form.unit ? availability : null;
  const short = ready !== null && form.quantity > ready.free;
  const invalid = (field: string) => (error?.field === field ? true : undefined);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await props.onSave({ ...form, teacher: isCoordinator ? form.teacher : user.name });
      props.onClose();
    } catch (err) {
      const field = err instanceof ApiError ? err.field : undefined;
      setError({ message: err instanceof Error ? err.message : 'Não foi possível criar a reserva.', field });
      if (field) formRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id(field))}`)?.focus();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal labelledBy={`${uid}-title`} className="reservation-modal" onClose={props.onClose}>
      <header className="modal-header">
        <h2 id={`${uid}-title`}>Nova reserva</h2>
        <button type="button" className="icon-button" onClick={props.onClose} aria-label="Fechar">
          <CloseIcon size={20} />
        </button>
      </header>

      <form ref={formRef} onSubmit={submit} noValidate>
        <label htmlFor={id('title')}>
          Título da atividade
          <input
            id={id('title')}
            data-autofocus
            required
            maxLength={config.limits.title}
            value={form.title}
            aria-invalid={invalid('title')}
            onChange={(e) => set('title', e.target.value)}
            placeholder="Ex.: Pesquisa orientada"
          />
        </label>

        <div className="form-row">
          <label htmlFor={id('teacher')}>
            Professor
            <input
              id={id('teacher')}
              required
              maxLength={config.limits.teacher}
              value={isCoordinator ? form.teacher : user.name}
              readOnly={!isCoordinator}
              aria-readonly={!isCoordinator}
              title={isCoordinator ? undefined : 'A reserva fica no nome de quem está logado.'}
              aria-invalid={invalid('teacher')}
              onChange={(e) => set('teacher', e.target.value)}
              placeholder="Nome do professor"
            />
          </label>
          <label htmlFor={id('unit')}>
            Unidade
            <select id={id('unit')} value={form.unit} aria-invalid={invalid('unit')} onChange={(e) => set('unit', e.target.value)}>
              {config.units.map((u) => (
                <option key={u.name} value={u.name}>
                  {u.name} · {u.tablets} tablets
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="form-row">
          <label htmlFor={id('className')}>
            <span>
              Turma <span className="optional">(opcional)</span>
            </span>
            <input
              id={id('className')}
              maxLength={config.limits.className}
              value={form.className}
              aria-invalid={invalid('className')}
              onChange={(e) => set('className', e.target.value)}
              placeholder="Ex.: 8º ano A"
            />
          </label>
          <label htmlFor={id('quantity')}>
            Quantidade de tablets
            <input
              id={id('quantity')}
              type="number"
              inputMode="numeric"
              min={1}
              max={unitTablets}
              step={1}
              required
              value={quantityText}
              aria-invalid={invalid('quantity') ?? (short || undefined)}
              aria-describedby={`${uid}-availability`}
              onChange={(e) => {
                setQuantityText(e.target.value);
                set('quantity', e.target.value === '' ? Number.NaN : Number(e.target.value));
              }}
            />
          </label>
        </div>

        <div className="form-row">
          <label htmlFor={id('date')}>
            Data
            <input
              id={id('date')}
              type="date"
              required
              value={form.date}
              aria-invalid={invalid('date')}
              onChange={(e) => set('date', e.target.value)}
            />
          </label>
          <label htmlFor={`${uid}-period`}>
            Horário de aula
            <select
              id={`${uid}-period`}
              value={periodId}
              onChange={(e) => {
                const p = config.periods.find((x) => x.id === e.target.value);
                if (p) {
                  setForm((f) => ({ ...f, startTime: p.start, endTime: p.end }));
                  setError(null);
                }
              }}
            >
              <option value="custom" disabled={periodId !== 'custom'}>
                Personalizado
              </option>
              {config.periods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} · {p.start}–{p.end}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="form-row">
          <label htmlFor={id('startTime')}>
            Início
            <input
              id={id('startTime')}
              type="time"
              step={300}
              required
              value={form.startTime}
              aria-invalid={invalid('startTime')}
              onChange={(e) => set('startTime', e.target.value)}
            />
          </label>
          <label htmlFor={id('endTime')}>
            Término
            <input
              id={id('endTime')}
              type="time"
              step={300}
              required
              value={form.endTime}
              aria-invalid={invalid('endTime')}
              onChange={(e) => set('endTime', e.target.value)}
            />
          </label>
        </div>

        <div
          id={`${uid}-availability`}
          className={`availability ${short || endBeforeStart ? 'is-short' : ''}`}
          aria-live="polite"
        >
          {ready && !endBeforeStart ? (
            <>
              <div className="availability-text">
                <strong>
                  {ready.free} de {ready.total}
                </strong>{' '}
                tablets livres na unidade {ready.unit} em {formatLongDate(ready.day)}, {form.startTime}–
                {form.endTime}
              </div>
              <div className="availability-bar" aria-hidden="true">
                <span style={{ width: `${((ready.total - ready.free) / ready.total) * 100}%` }} />
              </div>
              {short && <small>Diminua a quantidade ou escolha outro horário.</small>}
            </>
          ) : (
            <div className="availability-text">
              {endBeforeStart
                ? 'O término precisa ser depois do início. Ajuste os horários para ver quantos tablets estão livres.'
                : availability.state === 'loading' || availability.state === 'ready'
                  ? 'Conferindo quantos tablets estão livres…'
                  : availability.state === 'error'
                    ? 'Não foi possível conferir a disponibilidade agora. A conferência será feita ao salvar.'
                    : 'Escolha data e horário para ver quantos tablets estão livres.'}
            </div>
          )}
        </div>

        <label htmlFor={id('notes')}>
          <span>
            Observações <span className="optional">(opcional)</span>
          </span>
          <textarea
            id={id('notes')}
            rows={2}
            maxLength={config.limits.notes}
            value={form.notes}
            aria-invalid={invalid('notes')}
            onChange={(e) => set('notes', e.target.value)}
            placeholder="Informações adicionais"
          />
        </label>

        {error && (
          <p className="form-error" role="alert">
            {error.message}
          </p>
        )}

        <footer className="modal-actions">
          <button type="button" className="secondary-button" onClick={props.onClose}>
            Cancelar
          </button>
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? 'Salvando…' : 'Salvar reserva'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
