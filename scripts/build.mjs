// Gera a interface em dist/public: um JS e um CSS com hash no nome, mais o index.html.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const out = 'dist/public';
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/assets`, { recursive: true });

const result = await build({
  entryPoints: ['web/src/main.tsx'],
  bundle: true,
  minify: true,
  sourcemap: true,
  format: 'esm',
  target: ['es2022', 'chrome100', 'safari15', 'firefox100'],
  jsx: 'automatic',
  outdir: `${out}/assets`,
  entryNames: 'app-[hash]',
  metafile: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});

const files = Object.keys(result.metafile.outputs).map((f) => basename(f));
const js = files.find((f) => f.endsWith('.js'));
const css = files.find((f) => f.endsWith('.css'));
if (!js || !css) throw new Error('Build sem JS ou CSS.');

cpSync('web/public', out, { recursive: true });
const html = readFileSync('web/index.html', 'utf8').replace('%JS%', js).replace('%CSS%', css);
writeFileSync(`${out}/index.html`, html);
console.log(`Interface gerada em ${out}: ${js}, ${css}`);
