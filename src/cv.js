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
    // pdf-parse v2 exposes a PDFParse class, not a default function
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    const { text: raw } = await parser.getText();
    // it appends per-page markers like "-- 1 of 3 --"
    const text = tidy(String(raw || '').replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gim, ''));
    if (!text) {
      throw new Error('kunde inte läsa text ur PDF:en — är den inskannad som bild? Klistra in texten manuellt istället.');
    }
    return text;
  }

  if (ext === 'docx') {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ buffer });
    const text = tidy(value);
    if (!text) throw new Error('kunde inte läsa text ur DOCX-filen');
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
