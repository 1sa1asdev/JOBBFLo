import Dokument from '../../components/Dokument.jsx';
import { operatör } from '../../src/operator.js';

export const metadata = { title: 'JOBBFLO — villkor' };
export const dynamic = 'force-dynamic';

export default function Villkor() {
  const op = operatör();
  return (
    <Dokument rubrik="Villkor" uppdaterad="20 oktober 2026">
      <p>
        Jobbflo tillhandahålls av {op.namn}. Genom att logga in godkänner du villkoren nedan och
        {' '}<a className="llm-link" href="/integritet">integritetspolicyn</a>.
      </p>

      <h3>Tjänsten</h3>
      <p>
        Jobbflo samlar annonser från Arbetsförmedlingen, bedömer dem mot ditt CV, skriver förslag till
        brev och skickar dem från ditt Gmail-konto. Svaren läses och kopplas till rätt ansökan.
      </p>

      <h3>Ditt konto</h3>
      <ul>
        <li>Du loggar in med ditt Google-konto och ansvarar för det.</li>
        <li>
          Brev skickas från ditt Gmail med ett applösenord som du skapar och kan återkalla hos Google
          när som helst.
        </li>
        <li>
          AI-tjänsterna använder din egen nyckel. Kostnaden betalar du till leverantören, och den
          månadsbudget du sätter i Jobbflo stoppar bedömningen när den är nådd.
        </li>
      </ul>

      <h3>Det du skickar</h3>
      <ul>
        <li>
          Du ansvarar för innehållet i dina ansökningar. Ett brev du skickar själv går iväg först när du
          godkänt det.
        </li>
        <li>
          En kampanj skickar brev automatiskt, efter de regler och den takt du själv ställer in. Du
          ansvarar för dem på samma sätt, och du kan pausa kampanjen när som helst.
        </li>
        <li>
          Bedömningarna är ett stöd, inte en garanti. Varje poäng räknas fram ur rader du kan läsa, och
          det är du som avgör vad du söker.
        </li>
      </ul>

      <h3>Inte tillåtet</h3>
      <ul>
        <li>Att skicka massutskick, reklam eller annat än riktiga ansökningar.</li>
        <li>Att använda någon annans Google-konto, Gmail eller AI-nyckel.</li>
        <li>Att försöka komma åt andra användares uppgifter eller belasta tjänsten onormalt.</li>
      </ul>
      <p>Ett konto som bryter mot detta kan spärras. Spärren pausar kampanjerna och stoppar läsningen av mejl.</p>

      <h3>Ansvar</h3>
      <p>
        Tjänsten levereras i befintligt skick. Vi gör vad vi kan för att den ska fungera, men vi ansvarar
        inte för uteblivna svar, missade annonser eller kostnader hos leverantörer du själv valt, utöver
        vad som följer av tvingande lag.
      </p>

      <h3>Avsluta</h3>
      <p>
        Du kan radera ditt konto när som helst under Profil → Konto. Allt tas bort, se integritetspolicyn.
      </p>

      <h3>Ändringar och lag</h3>
      <p>
        Ändras villkoren står det överst, med datum. Svensk lag gäller. Frågor skickar du till {op.epost}.
      </p>
    </Dokument>
  );
}
