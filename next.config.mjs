/** @type {import('next').NextConfig} */
const nextConfig = {
  // A verification build must not write into .next, which `next dev`
  // is actively serving from — doing so leaves the dev server pointing
  // at chunks that no longer exist ("Cannot find module './331.js'").
  distDir: process.env.JOBBFLO_BUILD_CHECK ? '.next-check' : '.next',
  // Server-only packages that must NOT be bundled.
  // pg: native-ish, keep out of the client bundle graph.
  // pdf-parse/pdfjs-dist: bundling mangles their internals and PDF
  //   parsing dies with "Object.defineProperty called on non-object".
  // mammoth: same class of problem (DOCX/zip internals).
  // @napi-rs/canvas: a native binary (DOMMatrix for pdfjs, src/cv.js) —
  //   loaded per platform at runtime, so it must be traced, not bundled.
  serverExternalPackages: ['pg', 'pdf-parse', 'pdfjs-dist', 'mammoth', '@napi-rs/canvas'],
  // forbidden() and unauthorized() (src/auth.js): one place decides that
  // a blocked account gets 403 and a lost session 401, in every route
  // and page, instead of each of eighty handlers catching it.
  experimental: { authInterrupts: true },
};

export default nextConfig;
