import { NextResponse } from 'next/server';
import { loadTaxonomy } from '../../../src/taxonomy.js';

export const dynamic = 'force-dynamic';

// Municipality + region names for the location picker. These are
// the ONLY values JobSearch accepts (via concept-id translation),
// so offering free text here would just recreate the zero-hit bug.
export async function GET(req) {
  const q = (new URL(req.url).searchParams.get('q') || '').toLowerCase().trim();
  const tax = await loadTaxonomy();

  // use the taxonomy's own labels — re-capitalising lowercased keys
  // mangles Swedish ("Stockholms LäN")
  const names = (type) => [...new Set(tax[type]?.labels || [])];

  let municipalities = names('municipality');
  // AF's region list includes EURES regions across Europe; a Swedish
  // job search only wants the 21 län
  let regions = names('region').filter((r) => /\slän$/i.test(r));

  if (q) {
    municipalities = municipalities.filter((n) => n.toLowerCase().includes(q));
    regions = regions.filter((n) => n.toLowerCase().includes(q));
  }

  return NextResponse.json({
    municipalities: municipalities.sort().slice(0, 40),
    regions: regions.sort().slice(0, 30),
  });
}
