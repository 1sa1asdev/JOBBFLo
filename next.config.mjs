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
  serverExternalPackages: ['pg', 'pdf-parse', 'pdfjs-dist', 'mammoth'],
};

export default nextConfig;
