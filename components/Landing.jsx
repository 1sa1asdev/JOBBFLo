// ------------------------------------------------------------
// The page a visitor sees before signing in: what Jobbflo does, shown
// rather than claimed, with the sign-in next to it.
//
// The "screenshots" are the app's own views rebuilt in miniature with
// made-up data, not images. They stay sharp at every width, follow the
// app's colours when those change, and cannot leak anyone's CV, letters
// or employers — a real screenshot of a real account would.
//
// A video walkthrough slots in under the steps once one exists: put the
// file in public/ and name it in DEMO_VIDEO.
// ------------------------------------------------------------
const DEMO_VIDEO = null; // t.ex. '/demo.mp4'

function Steg({ nr, rubrik, children, visning }) {
  return (
    <section className="lp-step">
      <div className="lp-step-text">
        <span className="lp-step-nr">{String(nr).padStart(2, '0')}</span>
        <h3>{rubrik}</h3>
        {children}
      </div>
      <div className="lp-shot" aria-hidden="true">{visning}</div>
    </section>
  );
}

// 1 — the search, from plain words to filters
function VisaSökning() {
  return (
    <>
      <div className="lp-shot-bar">Ny sökning</div>
      <div className="lp-shot-body">
        <div className="lp-bubble">Junior frontend i Göteborg, gärna React. Heltid.</div>
        <div className="lp-label">Blir filter</div>
        <div className="lp-chips">
          <span>Göteborg</span><span>Mjukvaruutvecklare</span><span>Heltid</span><span>Tillsvidare</span>
        </div>
        <div className="lp-count"><b>412</b> annonser matchar · sorterade efter hur nära de ligger det du skrev</div>
      </div>
    </>
  );
}

// 2 — the checklist: the grade is the sum of rows you can read
function VisaBedömning() {
  const rader = [
    ['ok', 'React', '”3 års erfarenhet av React och Next.js”'],
    ['ok', 'Svenska och engelska', '”Flytande i svenska och engelska”'],
    ['delvis', 'TypeScript', '”Grundläggande TypeScript i skolprojekt”'],
    ['nej', 'B-körkort', 'Nämns inte i CV:t'],
  ];
  return (
    <>
      <div className="lp-shot-bar">Frontendutvecklare · Exempel AB <span className="lp-score">74</span></div>
      <div className="lp-shot-body lp-checks">
        {rader.map(([s, krav, citat]) => (
          <div key={krav} className={`lp-check ${s}`}>
            <span className="lp-check-mark">{s === 'ok' ? '✓' : s === 'delvis' ? '~' : '✗'}</span>
            <span className="lp-check-krav">{krav}</span>
            <span className="lp-check-citat">{citat}</span>
          </div>
        ))}
        <div className="lp-count">Betyget är summan av raderna, inte en gissning.</div>
      </div>
    </>
  );
}

// 3 — the letter, sent only when you say so
function VisaBrev() {
  return (
    <>
      <div className="lp-shot-bar">Brev · Exempel AB</div>
      <div className="lp-shot-body">
        <p className="lp-letter">
          Hej! Jag söker tjänsten som frontendutvecklare eftersom ni bygger med React,
          som jag arbetat med i tre år — senast i ett bokningssystem för …
        </p>
        <div className="lp-bubble lp-bubble-du">Gör det lite kortare och nämn att jag kan börja i januari.</div>
        <div className="lp-actions"><span className="lp-btn">Ändra mer</span><span className="lp-btn primary">Skicka nu</span></div>
      </div>
    </>
  );
}

// 4 — the answers, sorted
function VisaSvar() {
  const rader = [
    ['Exempel AB', 'Intervju', 'ok'],
    ['Byggbolaget i Norr', 'Avslag', 'nej'],
    ['Göteborgs Stad', 'Fråga till dig', 'flag'],
    ['Techbolaget', 'Väntar svar', ''],
  ];
  return (
    <>
      <div className="lp-shot-bar">Inkorg</div>
      <div className="lp-shot-body lp-inbox">
        {rader.map(([vem, status, ton]) => (
          <div key={vem} className="lp-inbox-row">
            <span>{vem}</span>
            <span className={`lp-tag ${ton}`}>{status}</span>
          </div>
        ))}
      </div>
    </>
  );
}

export default function Landing({ inloggning }) {
  return (
    <div className="lp">
      <header className="lp-top">
        <span className="lp-brand">Jobbflo</span>
        <span className="lp-beta">Testversion</span>
        <a className="lp-top-login" href="#logga-in">Logga in</a>
      </header>

      <div className="lp-hero">
        <div className="lp-hero-text">
          <div className="lp-eyebrow">Jobbsökning med AI · för den svenska arbetsmarknaden</div>
          <h1>Sök jobb med en plan, inte med tur.</h1>
          <p className="lp-lede">
            Jobbflo går igenom annonserna i Platsbanken, bedömer dem mot ditt CV krav för krav,
            skriver ett personligt brev till de jobb du väljer och håller koll på vem som svarat.
          </p>
          <ul className="lp-points">
            <li>Varje bedömning visar <b>varför</b> — med citat ur annonsen och ditt CV.</li>
            <li><b>Inget skickas utan ditt ja</b> — till brevet, eller till en kampanj och dess regler.</li>
            <li>Du använder <b>din egen AI-nyckel</b> och ser vad det kostar innan något dras.</li>
          </ul>
        </div>
        <div className="lp-hero-login" id="logga-in">{inloggning}</div>
      </div>

      <div className="lp-how">
        <div className="lp-section-head">
          <span className="lp-eyebrow">Så funkar det</span>
          <h2>Fyra steg, från annons till svar</h2>
        </div>

        <Steg nr={1} rubrik="Berätta vad du söker" visning={<VisaSökning />}>
          <p>Skriv med egna ord. Jobbflo gör om det till filter som Platsbanken förstår — ort,
            yrke, omfattning — och sorterar träffarna efter hur nära de ligger det du beskrev.</p>
        </Steg>

        <Steg nr={2} rubrik="Se hur väl du matchar, och varför" visning={<VisaBedömning />}>
          <p>Annonsens krav läses ut och prövas mot ditt CV ett i taget, med citat från båda
            sidor. Betyget räknas fram ur raderna, så du kan alltid se hur det blev som det blev.</p>
        </Steg>

        <Steg nr={3} rubrik="Ett brev för just det jobbet" visning={<VisaBrev />}>
          <p>Brevet bygger på kraven du faktiskt uppfyller. Ändra det i chatten tills det låter
            som du, och skicka när du är nöjd — från ditt eget Gmail.</p>
        </Steg>

        <Steg nr={4} rubrik="Svaren hittar hem" visning={<VisaSvar />}>
          <p>Jobbflo läser svaren på dina brev, sorterar dem — intervju, avslag, fråga — och
            föreslår ett svar. Bara trådar som börjar med ett brev du skickat via appen läses.</p>
        </Steg>

        {DEMO_VIDEO && (
          <section className="lp-video">
            <div className="lp-section-head">
              <span className="lp-eyebrow">Se en genomgång</span>
              <h2>Jobbflo på två minuter</h2>
            </div>
            <video src={DEMO_VIDEO} controls preload="metadata" playsInline />
          </section>
        )}
      </div>

      <div className="lp-facts">
        <div>
          <span className="lp-eyebrow">Kampanjer</span>
          <p>Vill du söka brett kan en kampanj bedöma nya annonser och skicka ett brev du godkänt,
            inom regler du sätter: lägsta betyg, orter och hur många brev per dygn.</p>
        </div>
        <div>
          <span className="lp-eyebrow">Kostnad</span>
          <p>Du betalar AI-leverantören direkt med din egen nyckel. Innan du börjar visar
            appen ungefär vad dina val kostar i månaden.</p>
        </div>
        <div>
          <span className="lp-eyebrow">Integritet</span>
          <p>Dina nycklar och lösenord lagras krypterade. Du kan när som helst ladda ner allt
            om dig eller radera kontot. <a href="/integritet">Läs integritetspolicyn</a>.</p>
        </div>
      </div>

      <div className="lp-end">
        <h2>Redo att prova?</h2>
        <a className="btn primary lp-end-btn" href="#logga-in">Logga in och kom igång →</a>
      </div>

      <footer className="lp-foot">
        <span>Jobbflo</span>
        <a href="/villkor">Villkor</a>
        <a href="/integritet">Integritet</a>
      </footer>
    </div>
  );
}
