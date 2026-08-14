/** @type {import('next').NextConfig} */
const nextConfig = {
  // Server-only packages that must NOT be bundled.
  // pg: native-ish, keep out of the client bundle graph.
  // pdf-parse/pdfjs-dist: bundling mangles their internals and PDF
  //   parsing dies with "Object.defineProperty called on non-object".
  // mammoth: same class of problem (DOCX/zip internals).
  serverExternalPackages: ['pg', 'pdf-parse', 'pdfjs-dist', 'mammoth'],
};

export default nextConfig;
