import { copyFile } from 'node:fs/promises';
import { build } from 'esbuild';

await build({
  entryPoints: ['web/app.jsx'],
  outfile: 'dist/app.js',
  bundle: true,
  jsx: 'automatic',
  minify: true,
  legalComments: 'eof',
  define: { 'process.env.NODE_ENV': '"production"' },
});
await copyFile('web/index.html', 'dist/index.html');
