import { useId, useState } from 'react';
import {
  STATUS_LABEL,
  canBeCancelled,
  canRegisterReturn,
  displayStatus,
  formatLongDate,
  formatTime,
  parseLocal,
} from '../../../shared/rules.ts';
import type { Reservation } from '../../../shared/types.ts';
import { CloseIcon } from '../icons.tsx';
import { Modal } from './Modal.tsx';

interface ReservationDetailsProps {
  reservation: Reservation;
  now: Date;
  /** Quem criou a reserva ou a coordenação. */
  canManage: boolean;
  onClose: () => void;
  onCancel: (id: string) => Promise<void>;
  onReturn: (id: string) => Promise<void>;
}

export function ReservationDetails({ reservation: r, now, canManage, onClose, onCancel, onReturn }: ReservationDetailsProps) {
  const uid = useId();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const status = displayStatus(r, now);
  const start = parseLocal(r.start);
  const end = parseLocal(r.end);
  const cancellable = canBeCancelled(status);
  const returnable = canRegisterReturn(status);

  async function run(action: (id: string) => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action(r.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível concluir a ação.');
      setBusy(false);
    }
  }

  return (
    <Modal labelledBy={`${uid}-title`} className="details-modal" onClose={onClose}>
      <button type="button" className="icon-button close-details" onClick={onClose} aria-label="Fechar">
        <CloseIcon size={20} />
      </button>
      <span className={`status-pill status-${status}`}>{STATUS_LABEL[status]}</span>
      <h2 id={`${uid}-title`}>{r.title}</h2>
      <p className="details-subtitle">
        {r.teacher} · {r.unit}
      </p>
      <dl className="details-list">
        <dt>Data</dt>
        <dd>{formatLongDate(start)}</dd>
        <dt>Horário</dt>
        <dd>
          {formatTime(start)} – {formatTime(end)}
        </dd>
        <dt>Turma</dt>
        <dd>{r.className || 'Não informada'}</dd>
        <dt>Quantidade</dt>
        <dd>
          {r.quantity} {r.quantity === 1 ? 'tablet' : 'tablets'}
        </dd>
        {r.notes && (
          <>
            <dt>Observações</dt>
            <dd className="detail-note">{r.notes}</dd>
          </>
        )}
      </dl>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {!canManage && (cancellable || returnable) && (
        <p className="permission-note">Só {r.teacher} ou a coordenação podem cancelar ou registrar a devolução desta reserva.</p>
      )}

      {confirming ? (
        <div className="confirm-box" role="group" aria-label="Confirmar cancelamento">
          <p>Cancelar esta reserva? Os {r.quantity} tablets voltam a ficar livres nesse horário.</p>
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={() => setConfirming(false)} disabled={busy}>
              Manter reserva
            </button>
            <button type="button" className="danger-button" onClick={() => run(onCancel)} disabled={busy}>
              {busy ? 'Cancelando…' : 'Sim, cancelar'}
            </button>
          </div>
        </div>
      ) : (
        <div className="modal-actions details-actions">
          {canManage && cancellable && (
            <button type="button" className="secondary-button danger-text" onClick={() => setConfirming(true)} disabled={busy}>
              Cancelar reserva
            </button>
          )}
          {canManage && returnable && (
            <button type="button" className="secondary-button" onClick={() => run(onReturn)} disabled={busy}>
              {busy ? 'Registrando…' : 'Registrar devolução'}
            </button>
          )}
          <button type="button" className="primary-button" onClick={onClose}>
            Fechar
          </button>
        </div>
      )}
    </Modal>
  );
}
