// ------------------------------------------------------------
// CV extraction. The scoring and letter prompts consume plain
// text, so every upload path funnels down to a string.
// PDF and DOCX are parsed locally — a CV is personal data and
// has no business going to a third-party conversion service.
// ------------------------------------------------------------

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB, matches the UI copy

function tidy(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export async function extractCvText(buffer, filename = '') {
  if (!buffer?.length) throw new Error('tom fil');
  if (buffer.length > MAX_BYTES) throw new Error('filen är större än 10 MB');

  const ext = filename.toLowerCase().split('.').pop();

  if (ext === 'txt' || ext === 'md') {
    return tidy(buffer.toString('utf8'));
  }

  if (ext === 'pdf') {
    // NOTE: pdf-parse/pdfjs must stay OUT of the Next bundle
    // (serverExternalPackages) — bundling breaks them at runtime with
    // "Object.defineProperty called on non-object".
    //
    // pdfjs 5 needs DOMMatrix, Path2D and ImageData, which Node lacks. It
    // looks for @napi-rs/canvas on its own, by a path the build cannot
    // see — so on Vercel the canvas package was never shipped with the
    // route, and every PDF upload failed with "DOMMatrix is not defined"
    // (it worked locally, where all of node_modules is present).
    // pdf-parse/worker imports them from @napi-rs/canvas by name, which
    // the build does follow, and sets them as globals: so it is imported
    // first. Its getData() is pdfjs's worker as a data URL, so no worker
    // file has to survive the bundle either.
    let raw;
    let parser;
    try {
      const { CanvasFactory, getData } = await import('pdf-parse/worker');
      // pdf-parse v2 exposes a PDFParse class, not a default function
      const { PDFParse } = await import('pdf-parse');
      PDFParse.setWorker(getData());
      parser = new PDFParse({ data: buffer, CanvasFactory });
      ({ text: raw } = await parser.getText());
    } catch (err) {
      const m = err.message || '';
      if (/password|encrypt/i.test(m)) {
        throw new Error('PDF:en är lösenordsskyddad — spara en olåst kopia och försök igen.');
      }
      if (/invalid pdf|structure/i.test(m)) {
        throw new Error('filen ser inte ut som en giltig PDF — är den helt nedladdad? Prova att spara om den, eller klistra in texten.');
      }
      throw new Error(`kunde inte läsa PDF:en (${m.slice(0, 80)}) — klistra in texten istället.`);
    } finally {
      await parser?.destroy().catch(() => {});
    }
    // it appends per-page markers like "-- 1 of 3 --"
    const text = tidy(String(raw || '').replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gim, ''));
    if (!text) {
      throw new Error('hittade ingen text i PDF:en — är den inskannad som bild? Klistra in texten manuellt istället.');
    }
    return text;
  }

  if (ext === 'docx') {
    let value;
    try {
      const mammoth = await import('mammoth');
      ({ value } = await mammoth.extractRawText({ buffer }));
    } catch (err) {
      throw new Error(`kunde inte läsa DOCX-filen (${(err.message || '').slice(0, 80)}) — spara som PDF eller klistra in texten.`);
    }
    const text = tidy(value);
    if (!text) throw new Error('hittade ingen text i DOCX-filen');
    return text;
  }

  if (ext === 'doc') {
    throw new Error('gammalt .doc-format stöds inte — spara om som .docx eller PDF');
  }

  throw new Error(`filformatet .${ext} stöds inte (använd PDF, DOCX, TXT)`);
}

// Rough sanity check so an obviously wrong file (a payslip, a
// cover letter) doesn't silently become the basis for scoring.
export function looksLikeCv(text) {
  const t = String(text || '').toLowerCase();
  if (t.length < 200) return { ok: false, why: 'texten är väldigt kort för att vara ett CV' };
  const signals = [
    /utbildning|education|studier/, /erfarenhet|experience|anställning|arbetslivserfarenhet/,
    /kompetens|skills|teknik|språk|languages/, /projekt|projects/,
  ];
  const hits = signals.filter((re) => re.test(t)).length;
  if (hits < 2) return { ok: false, why: 'texten ser inte ut som ett CV (saknar rubriker om utbildning/erfarenhet)' };
  return { ok: true };
}
