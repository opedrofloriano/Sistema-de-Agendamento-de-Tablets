// Entrada da versão de demonstração (arquivo HTML único, sem servidor).
// O empacotador troca ../api.ts por ./api.demo.ts (veja scripts/build-demo.mjs).

import { StrictMode, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { MeResponse } from '../../../shared/types.ts';
import { App } from '../App.tsx';
import { CalendarIcon } from '../icons.tsx';
import '../styles.css';
import { api, demoLogin, demoReset, demoUser } from './api.demo.ts';

function DemoLogin({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [coord, setCoord] = useState(false);
  const [reset, setReset] = useState(false);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    demoLogin(name, coord);
    onDone();
  }

  return (
    <div className="boot-screen">
      <form className="demo-login" onSubmit={submit}>
        <div className="brand-mark" aria-hidden="true">
          <CalendarIcon size={22} />
        </div>
        <h1>Agendamento de Tablets</h1>
        <p className="demo-login-note">
          Versão de demonstração. As reservas ficam salvas só neste navegador. No sistema real, o acesso é pela conta
          Microsoft da escola.
        </p>
        <label htmlFor="demo-name">
          Seu nome
          <input id="demo-name" value={name} maxLength={80} required autoFocus onChange={(e) => setName(e.target.value)} placeholder="Ex.: Ana Ribeiro" />
        </label>
        <label className="demo-check" htmlFor="demo-coord">
          <input id="demo-coord" type="checkbox" checked={coord} onChange={(e) => setCoord(e.target.checked)} />
          Sou da coordenação
        </label>
        <button type="submit" className="primary-button" disabled={!name.trim()}>
          Entrar
        </button>
        <button
          type="button"
          className="demo-reset"
          onClick={() => {
            demoReset();
            setReset(true);
          }}
        >
          {reset ? 'Dados de exemplo restaurados' : 'Restaurar dados de exemplo'}
        </button>
      </form>
    </div>
  );
}

function Root() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [needsLogin, setNeedsLogin] = useState(() => demoUser() === null);

  useEffect(() => {
    if (needsLogin) return;
    void api.me().then(setMe, () => setNeedsLogin(true));
  }, [needsLogin]);

  if (needsLogin) return <DemoLogin onDone={() => setNeedsLogin(false)} />;
  if (!me) {
    return (
      <div className="boot-screen" aria-busy="true">
        <p>Carregando agenda…</p>
      </div>
    );
  }
  return <App me={me} />;
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
