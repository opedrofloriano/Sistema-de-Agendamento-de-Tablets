// Sobe o sistema com o login de desenvolvimento (sem Microsoft). Funciona no Windows, Linux e macOS.
process.env.AUTH_MODE ??= 'dev';
process.env.NODE_ENV ??= 'development';
await import('./build.mjs');
await import('../server/main.ts');
