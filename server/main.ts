// Ponto de entrada: `npm start` (ou `node server/main.ts`).

import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const { loadConfig } = await import('./config.ts');
let cfg: ReturnType<typeof loadConfig>;
try {
  cfg = loadConfig();
} catch (err) {
  console.error(`Não foi possível iniciar: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// Todas as datas do sistema seguem o fuso da escola, não o do servidor.
process.env.TZ = cfg.app.timezone;

const { createApp } = await import('./app.ts');
const app = await createApp(cfg);

app.server.listen(cfg.port, cfg.host, () => {
  console.log(
    `Agendamento de Tablets em ${cfg.baseUrl} (porta ${cfg.port}, login: ${cfg.authMode}, banco: ${app.db.kind === 'turso' ? 'Turso' : 'arquivo local'}).`,
  );
  if (cfg.authMode === 'dev') console.warn('ATENÇÃO: login de desenvolvimento ativo. Não use em produção.');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
