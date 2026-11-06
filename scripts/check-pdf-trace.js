// Checks, after `next build`, that the routes which read PDFs ship the
// canvas package pdfjs needs.
//
//   npm run build && node scripts/check-pdf-trace.js
//
// pdfjs 5 needs DOMMatrix, which Node lacks; src/cv.js gets it from
// @napi-rs/canvas through pdf-parse/worker. On Vercel a route only has
// the files the build traced into it, and before that import the canvas
// package was not among them: every PDF upload on the hosted app failed
// with "DOMMatrix is not defined" while working on a laptop, where all
// of node_modules is present. This reads the build's file lists
// (.next/server/**/route.js.nft.json) and fails if the package or its
// native binary is missing — on CI's Linux, the Linux binary.
import { readFileSync, existsSync } from 'node:fs';

const RUTTER = ['cv', 'applications/[id]/attachments'];
let fel = 0;
for (const rutt of RUTTER) {
  const fil = `.next/server/app/api/${rutt}/route.js.nft.json`;
  if (!existsSync(fil)) {
    console.log(`✗ ${rutt}: ${fil} saknas — kör npm run build först`);
    fel += 1;
    continue;
  }
  const filer = JSON.parse(readFileSync(fil, 'utf8')).files;
  const canvas = filer.filter((f) => /@napi-rs[\\/]canvas[\\/]/.test(f)).length;
  const binär = filer.find((f) => /@napi-rs[\\/]canvas-[^\\/]+[\\/].*\.node$/.test(f));
  const ok = canvas > 0 && Boolean(binär);
  if (!ok) fel += 1;
  console.log(`${ok ? '✓' : '✗'} /api/${rutt}: @napi-rs/canvas ${canvas} filer, binär ${binär ? binär.split(/[\\/]/).slice(-2).join('/') : 'saknas'}`);
}
console.log(fel ? `\n${fel} fel — PDF-uppladdning skulle ge "DOMMatrix is not defined" på Vercel` : '\nallt följer med');
process.exit(fel ? 1 : 0);
