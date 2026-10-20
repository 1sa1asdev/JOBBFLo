import Dokument from '../../components/Dokument.jsx';
import { operatör } from '../../src/operator.js';

export const metadata = { title: 'JOBBFLO — integritetspolicy' };
export const dynamic = 'force-dynamic';

// What Jobbflo does with personal data. Every claim here is something
// the code does — the walk in src/konto.js, the scope of the mail loop,
// the providers in DEPLOY.md. Change one, change the other.
export default function Integritet() {
  const op = operatör();
  return (
    <Dokument rubrik="Integritetspolicy" uppdaterad="20 oktober 2026">
      <p>
        Jobbflo hjälper dig att hitta jobb, bedöma annonser mot ditt CV och skicka ansökningar från
        ditt eget Gmail-konto. Här står vilka uppgifter om dig som sparas, varför, vem som får del av
        dem och hur du tar bort dem.
      </p>

      <h3>Vem ansvarar</h3>
      <p>Personuppgiftsansvarig är {op.namn}. Frågor om dina uppgifter skickar du till {op.epost}.</p>

      <h3>Vilka uppgifter som sparas</h3>
      <ul>
        <li><b>Konto:</b> namn och e-postadress från ditt Google-konto.</li>
        <li><b>Profil och CV:</b> det du laddar upp eller skriver in, till exempel CV, ort och kontaktuppgifter.</li>
        <li><b>Sökningar och kampanjer:</b> dina kriterier, chatten om dem och de annonser du sparat eller låtit bedöma, med bedömningarna.</li>
        <li><b>Ansökningar:</b> breven, vart de skickades och när.</li>
        <li>
          <b>Mejl:</b> bara trådar som börjar med ett brev du skickat via Jobbflo, från ditt första sådana
          brev och framåt. Ingenting äldre i din inkorg läses, och mejl som inte hör till en sådan tråd
          lämnas orörda.
        </li>
        <li><b>Applösenord för Gmail och AI-nycklar:</b> sparas krypterade, och visas aldrig igen, inte ens för dig.</li>
        <li><b>Användning:</b> hur många tokens dina AI-anrop använde och vad de kostade, för att din budget ska kunna hållas.</li>
        <li>
          <b>Fel:</b> när något går fel sparas vilken sida det gällde och felmeddelandet i 30 dagar, utan
          koppling till ditt konto. Hur ofta du loggar in räknas per IP-adress i högst ett dygn, för att
          stoppa försök att gissa lösenord.
        </li>
      </ul>

      <h3>Varför, och med vilken rätt</h3>
      <p>
        Uppgifterna behövs för att leverera tjänsten du bett om: att bedöma annonser mot ditt CV, skriva
        och skicka dina brev och koppla svaren till rätt ansökan. Rättslig grund är avtalet med dig
        (artikel 6.1 b i dataskyddsförordningen). Skydd mot missbruk, som att spärra ett konto, sker med
        stöd av berättigat intresse (artikel 6.1 f).
      </p>

      <h3>Vem som får del av uppgifterna</h3>
      <ul>
        <li><b>Supabase</b>: databas och inloggning, i Stockholm.</li>
        <li><b>Vercel</b> och <b>Railway</b>: driften av webbplatsen och bakgrundsjobben.</li>
        <li><b>Google</b>: inloggningen, och Gmail som skickar och tar emot dina mejl på ditt eget konto.</li>
        <li>
          <b>AI-leverantören du själv väljer:</b> ditt CV, annonserna, dina brev och mejlen i dina trådar
          skickas dit för att läsas och skrivas, med din egen nyckel och under deras villkor. Väljer du
          en leverantör märkt EU stannar uppgifterna inom EU/EES.
        </li>
        <li><b>Arbetsgivare:</b> får ditt brev och dina bilagor när du skickar en ansökan.</li>
      </ul>
      <p>
        Jobbflo betalar själv bara för att indexera de offentliga annonserna. Inga uppgifter om dig ingår i det.
      </p>
      <p>
        Vercel, Railway, Google och vissa AI-leverantörer kan behandla uppgifter i USA. Det sker med stöd
        av EU:s standardavtalsklausuler eller EU–US Data Privacy Framework.
      </p>

      <h3>Hur länge</h3>
      <p>
        Så länge du har ett konto. Raderar du kontot tas allt ovan bort direkt, och finns sedan kvar i
        säkerhetskopior i högst sju dagar. Kvar blir bara anonyma rader om hur många tokens och hur mycket
        pengar AI-anropen kostade, utan koppling till dig.
      </p>

      <h3>Dina rättigheter</h3>
      <ul>
        <li><b>Se och ta med dig dina uppgifter:</b> Profil → Konto → <i>Ladda ner min data</i>.</li>
        <li><b>Rätta:</b> direkt i appen.</li>
        <li><b>Radera:</b> Profil → Konto → <i>Radera kontot</i>. Allt tas bort, inloggningen också.</li>
        <li><b>Invända eller fråga:</b> skriv till {op.epost}.</li>
        <li>
          <b>Klaga:</b> hos Integritetsskyddsmyndigheten,{' '}
          <a className="llm-link" href="https://www.imy.se" target="_blank" rel="noreferrer">imy.se</a>.
        </li>
      </ul>

      <h3>Uppgifter om andra</h3>
      <p>
        Annonser och svar innehåller kontaktuppgifter till arbetsgivare och rekryterare. De sparas i ditt
        konto för att du ska kunna söka jobbet och följa tråden, och raderas med det.
      </p>

      <h3>Cookies</h3>
      <p>
        Bara de som krävs för att hålla dig inloggad. Ingen spårning, ingen analys och ingen reklam.
      </p>

      <h3>Ändringar</h3>
      <p>Ändras policyn står det överst, med datum.</p>
    </Dokument>
  );
}
