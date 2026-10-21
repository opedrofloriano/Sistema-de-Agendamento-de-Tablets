// Gera dist/agendamento-tablets-demo.html: a interface inteira num arquivo só, sem servidor.
// Usa as mesmas telas e regras do sistema; só a camada de dados é trocada por web/src/demo/api.demo.ts.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const demoApi = resolve('web/src/demo/api.demo.ts');

/** Faz todo import de .../api.ts apontar para a API de demonstração. */
const swapApi = {
  name: 'demo-api',
  setup(b) {
    b.onResolve({ filter: /(^|\/)api\.ts$/ }, () => ({ path: demoApi }));
  },
};

const result = await build({
  entryPoints: ['web/src/demo/main.tsx'],
  bundle: true,
  minify: true,
  format: 'esm',
  target: ['es2022', 'chrome100', 'safari15', 'firefox100'],
  jsx: 'automatic',
  outdir: 'dist/demo-tmp',
  write: false,
  plugins: [swapApi],
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});

const js = result.outputFiles.find((f) => f.path.endsWith('.js')).text.replace(/<\/script/gi, '<\\/script');
const css = result.outputFiles.find((f) => f.path.endsWith('.css')).text.replace(/<\/style/gi, '<\\/style');
const themeInit = readFileSync('web/public/theme-init.js', 'utf8');

const html = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#f8fafd" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#0b0b0d" media="(prefers-color-scheme: dark)" />
    <meta name="description" content="Agendamento de Tablets — versão de demonstração" />
    <title>Agendamento de Tablets</title>
    <!-- Versão de demonstração gerada por scripts/build-demo.mjs. Reservas salvas só neste navegador. -->
    <script>${themeInit}</script>
    <style>${css}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">${js}</script>
  </body>
</html>
`;

mkdirSync('dist', { recursive: true });
writeFileSync('dist/agendamento-tablets-demo.html', html);
console.log(`Demonstração gerada: dist/agendamento-tablets-demo.html (${Math.round(html.length / 1024)} KB)`);
