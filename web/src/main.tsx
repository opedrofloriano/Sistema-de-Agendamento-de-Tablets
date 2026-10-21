import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { MeResponse } from '../../shared/types.ts';
import { App } from './App.tsx';
import { api } from './api.ts';
import './styles.css';

function Root() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Não foi possível abrir o agendamento.'));
  }, []);

  if (error) {
    return (
      <div className="boot-screen" role="alert">
        <p>{error}</p>
        <button type="button" className="primary-button" onClick={() => window.location.reload()}>
          Tentar de novo
        </button>
      </div>
    );
  }
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
