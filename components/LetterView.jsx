'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, daysUntil } from '../lib/api.js';

// Highlight verbatim quotes from matched[]/flags[] inside a paragraph.
// Quotes are max 15 words and MUST be verbatim (scoring invariant) —
// if one doesn't match the ad text, it silently doesn't highlight,
// which is the correct failure mode.
function markParagraph(text, spans, onJumpRegister) {
  const hits = [];
  for (const s of spans) {
    const idx = text.toLowerCase().indexOf(s.quote.toLowerCase());
    if (idx >= 0) hits.push({ ...s, idx, len: s.quote.length });
  }
  hits.sort((a, b) => a.idx - b.idx);

  const out = [];
  let pos = 0;
  for (const h of hits) {
    if (h.idx < pos) continue; // overlapping — keep first
    if (h.idx > pos) out.push(text.slice(pos, h.idx));
    out.push(
      <span key={h.id} id={h.id} className={h.neg ? 'hl-flag' : 'hl-match'} title={h.why}>
        {text.slice(h.idx, h.idx + h.len)}
      </span>
    );
    onJumpRegister(h.id);
    pos = h.idx + h.len;
  }
  out.push(text.slice(pos));
  return out;
}

export default function LetterView({ adId, search, letterState, setLetterState, onBack }) {
  const [data, setData] = useState(null); // {ad, match, duplicates, application}
  const [appDetail, setAppDetail] = useState(null); // versions + reuse warnings
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [adCollapsed, setAdCollapsed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [justSent, setJustSent] = useState(false);
  const [attachments, setAttachments] = useState(null);

  const application = letterState?.application || data?.application || null;

  const load = useCallback(async () => {
    try {
      const d = await api(`/api/ads/${adId}${search ? `?search=${search.id}` : ''}`);
      setData(d);
      if (d.application) {
        setLetterState({ application: d.application, ad: d.ad, match: d.match });
        const det = await api(`/api/applications/${d.application.id}`);
        setAppDetail(det);
      }
    } catch (e) { setError(e.message); }
  }, [adId, search?.id]);

  useEffect(() => { setError(null); setData(null); setAppDetail(null); load(); }, [load]);

  // what will actually ride along with this letter
  useEffect(() => {
    if (!application?.id) return;
    api(`/api/applications/${application.id}/attachments`)
      .then(setAttachments).catch(() => {});
  }, [application?.id]);

  // refresh detail (versions/warnings) after each revision
  useEffect(() => {
    if (application?.id && application.letter_version !== appDetail?.letter_version) {
      api(`/api/applications/${application.id}`).then(setAppDetail).catch(() => {});
    }
  }, [application?.letter_version, application?.id]);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const app = await api('/api/applications', {
        method: 'POST',
        body: { adId, searchId: search?.id },
      });
      setLetterState({ application: app, ad: data.ad, match: data.match });
      setAppDetail(await api(`/api/applications/${app.id}`));
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function restore(version) {
    const app = await api(`/api/applications/${application.id}`, {
      method: 'PATCH', body: { restore_version: Number(version) },
    });
    setLetterState((s) => ({ ...s, application: app }));
  }

  async function saveEdit() {
    const app = await api(`/api/applications/${application.id}`, {
      method: 'PATCH', body: { letter_text: editText },
    });
    setLetterState((s) => ({ ...s, application: app }));
    setEditing(false);
  }

  async function doSend() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/applications/${application.id}/send`, { method: 'POST', body: {} });
      setConfirming(false);
      setJustSent(true);
      await load();
    } catch (e) { setError(e.message); setConfirming(false); }
    setBusy(false);
  }

  if (!data) return <div className="loading-note">{error || 'Laddar…'}</div>;

  const { ad, match, duplicates } = data;
  const exp = daysUntil(ad.deadline);
  const sent = application?.status && application.status !== 'drafted';
  const jumpIds = [];
  const spans = [
    ...(match?.matched || []).map((m, i) => ({ ...m, id: `src-m${i}`, neg: false })),
    ...(match?.flags || []).map((f, i) => ({ ...f, id: `src-f${i}`, neg: true })),
  ];
  // highlighting only makes sense for quotes that are actually in the text
  const highlightable = spans.filter((s) => s.verbatim !== false);

  function jump(id) {
    const el = document.getElementById(id);
    if (!el) return;
    if (adCollapsed) setAdCollapsed(false);
    document.querySelectorAll('.pulse').forEach((p) => p.classList.remove('pulse'));
    el.classList.add('pulse');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => el.classList.remove('pulse'), 1800);
  }

  const paragraphs = (ad.description || '').split(/\n{2,}/);
  const letterParas = (application?.letter_text || '').split(/\n{2,}/);
  const wordCount = (application?.letter_text || '').split(/\s+/).filter(Boolean).length;

  return (
    <div className="stage-view" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="crumb">
        <button className="back" onClick={onBack}>← Tillbaka</button>
        <span className="path">{search?.name || 'Sökning'} <b>/ {ad.title}</b></span>
        <span className="steps">
          <span className="step done">Matchad</span>
          <span className={`step ${application ? 'done' : 'active'}`}>Utkast</span>
          <span className={`step ${sent ? 'done' : application ? 'active' : ''}`}>Granska</span>
          <span className={`step ${sent ? 'done' : ''}`}>Skickad</span>
        </span>
      </div>

      <div className="draft-head">
        <div>
          <div className="jt">{ad.title}</div>
          <div className="je">
            {ad.employer} — <b>{ad.municipality || '—'}</b>
            {exp != null && <> · ansök inom <b>{exp <= 0 ? 'IDAG' : `${exp} dagar`}</b></>}
            {ad.ats_vendor && <> · ansökan via <b>{ad.ats_vendor}</b></>}
          </div>
        </div>
        {match && <div className="score-badge"><span className="n">{match.score}</span> Matchning</div>}
      </div>

      {duplicates?.length > 0 && (
        <div className="err-note">
          ⚠ Möjlig dubblett: samma arbetsgivare/titel finns som {duplicates.length} annan annons
          {duplicates[0].status ? ` — du har redan status "${duplicates[0].status}" på en av dem` : ''}.
          Flaggas alltid, slås aldrig ihop automatiskt.
        </div>
      )}
      {error && <div className="err-note">{error}</div>}

      <div className="split">
        <div className="split-pane letter-pane">
          {appDetail?.reuse_warnings?.length > 0 && !sent && (
            <div className="reuse-warn">
              <span>
                ⚠ <b>Stycke {appDetail.reuse_warnings[0].paragraph}</b> är {appDetail.reuse_warnings[0].similarity}%
                identiskt med brevet till {appDetail.reuse_warnings[0].employer}
              </span>
            </div>
          )}
          <div className="pane-head">
            <span>Personligt brev{application ? ` · v${application.letter_version}` : ''}</span>
            {application && <span className="wc" style={{ margin: 0 }}><b>{wordCount}</b> ord</span>}
          </div>

          {application && !sent && (
            <div className="toolbar">
              <div className="tool">Version
                <select
                  aria-label="Version"
                  value={application.letter_version}
                  onChange={(e) => restore(e.target.value)}
                >
                  {(appDetail?.versions || [{ version: application.letter_version }]).map((v) => (
                    <option key={v.version} value={v.version}>
                      v{v.version}{v.version === (appDetail?.versions?.[0]?.version ?? v.version) ? ' (senaste)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="tool">
                <button onClick={() => { setEditing(!editing); setEditText(application.letter_text); }}>
                  {editing ? 'Avbryt' : 'Redigera i text'}
                </button>
              </div>
            </div>
          )}

          <div className="pane-scroll">
            {!application ? (
              <div className="sheet">
                <p style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 16 }}>
                  Inget utkast än. Brevet genereras utifrån ditt CV, dina projekt och de citerade
                  kraven ur annonsen — och skickas aldrig utan din bekräftelse.
                </p>
                <button className="btn primary" onClick={generate} disabled={busy}>
                  {busy ? 'Genererar…' : 'Generera utkast →'}
                </button>
              </div>
            ) : (
              <div className="sheet">
                <div className="subject-line">
                  <span className="lbl">Ämne</span>
                  <span className="val">{application.subject}</span>
                </div>
                {editing ? (
                  <div className="letter">
                    <textarea
                      className="letter-edit"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                    />
                    <button className="btn primary" style={{ marginTop: 10 }} onClick={saveEdit}>Spara text</button>
                  </div>
                ) : (
                  <div className="letter">
                    {letterParas.map((p, i) => <p key={i}>{p}</p>)}
                  </div>
                )}
                {/* mirror the mockup's "Bilagor" row — and make it honest:
                    if nothing is attached, say so here rather than let the
                    user discover it after sending */}
                <div className={`attach${attachments?.count ? '' : ' none'}`}>
                  Bilagor:
                  {attachments?.count
                    ? attachments.files.map((f) => (
                        <span className="file" key={f.filename}>
                          <span className="x">{(f.filename.split('.').pop() || '').toUpperCase().slice(0,4)}</span>
                          {f.filename}
                        </span>
                      ))
                    : <span className="file none">inget CV bifogas — ladda upp CV:t som fil i Profil</span>}
                </div>

                {spans.length > 0 && (
                  <div className="evidence">
                    <span className="elabel">Belägg ur annonsen — klicka för att se i källan</span>
                    {spans.map((s) => (
                      // only verbatim quotes exist in the ad text, so only
                      // those can be jumped to; the rest render as plain
                      // text rather than as links that go nowhere
                      s.verbatim === false ? (
                        <span key={s.id} className={`evidence-flat${s.neg ? ' neg' : ''}`}>
                          {s.quote}
                          <i>{s.neg ? '⚑ ' : ''}{s.why} · omskrivet, ej ordagrant</i>
                        </span>
                      ) : (
                        <button key={s.id} className={s.neg ? 'neg' : ''} onClick={() => jump(s.id)}>
                          ”{s.quote}”
                          <i>{s.neg ? '⚑ ' : ''}{s.why}</i>
                        </button>
                      )
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="split-pane ad-pane" data-collapsed={adCollapsed}>
          <div className="pane-head">
            <span>Annonstext</span>
            <button className="collapse" aria-expanded={!adCollapsed} onClick={() => setAdCollapsed(!adCollapsed)}>
              {adCollapsed ? '‹ Visa annons' : 'Dölj ›'}
            </button>
          </div>
          <div className="pane-scroll">
            <div className="adtext">
              <div className="legend">
                <span><i style={{ background: '#E4E9CF', borderBottom: '2px solid var(--ok)' }} /> Matchar</span>
                <span><i style={{ background: '#F0DCD4', borderBottom: '2px solid var(--flag)' }} /> Flaggat</span>
              </div>
              {paragraphs.map((p, i) => (
                <p key={i}>{markParagraph(p, highlightable, (id) => jumpIds.push(id))}</p>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="gate">
        <div className="recip">
          {ad.apply_email
            ? <>Skickas via Gmail till <b>{ad.apply_email}</b></>
            : ad.apply_url
              ? <>Ingen ansöknings-mejl — sök via <b><a href={ad.apply_url} target="_blank" rel="noreferrer">annonsens länk</a></b> och klistra in brevet</>
              : <>Annonsen saknar ansökningsväg</>}
        </div>
        {sent ? (
          <span className="gate-status">✓ Skickad {application.sent_at ? new Date(application.sent_at).toLocaleString('sv-SE') : ''}</span>
        ) : (
          <>
            <div className="warn">⚠ Inget skickas utan din bekräftelse</div>
            <div className="acts">
              {!ad.apply_email && application && (
                <button className="btn" onClick={() => navigator.clipboard.writeText(application.letter_text)}>
                  Kopiera brev
                </button>
              )}
              {ad.apply_email && (
                <button
                  className="btn primary"
                  disabled={!application || busy}
                  onClick={() => setConfirming(true)}
                >
                  Granska &amp; skicka →
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {confirming && application && (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirming(false); }}>
          <div className="modal" role="dialog" aria-modal="true">
            <div className="modal-head">
              <div className="idx">Sista steget</div>
              <h3>Bekräfta utskick</h3>
            </div>
            <div className="modal-body">
              <div className="confirm-row"><span className="k">Till</span><span className="v">{ad.apply_email}</span></div>
              <div className="confirm-row"><span className="k">Tjänst</span><span className="v">{ad.title}</span></div>
              <div className="confirm-row"><span className="k">Ämne</span><span className="v">{application.subject}</span></div>
              <div className="confirm-row">
                <span className="k">Bilagor</span>
                <span className="v">
                  {attachments?.count
                    ? attachments.files.map((f) => f.filename).join(', ')
                    : 'inga'}
                </span>
              </div>
              {!attachments?.count && (
                <div className="modal-warn" style={{ marginTop: 10 }}>
                  Inget CV bifogas. Annonser ber oftast om både CV och personligt brev —
                  ladda upp CV:t som fil (PDF/DOCX) i Profil om det ska följa med.
                </div>
              )}
              <div className="modal-warn">
                Mejlet skickas från ditt eget Gmail-konto i ditt namn. Det går inte att ångra efter utskick.
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setConfirming(false)}>Avbryt</button>
              <button className="btn primary" onClick={doSend} disabled={busy}>
                {busy ? 'Skickar…' : 'Skicka nu'}
              </button>
            </div>
          </div>
        </div>
      )}

      {justSent && (
        <div className="overlay" onClick={() => setJustSent(false)}>
          <div className="modal">
            <div className="modal-head"><h3>Skickad ✓</h3></div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.6 }}>
                Ansökan är skickad. Svar fångas automatiskt i Inkorgen.
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn primary" onClick={() => setJustSent(false)}>Stäng</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
