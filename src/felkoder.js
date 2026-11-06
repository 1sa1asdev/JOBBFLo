// ------------------------------------------------------------
// What went wrong when a letter was sent, as one code that every part
// agrees on: the worker's log line, auto_apply_log.code, a campaign's
// pause reason and the send routes' answers. Before this, each place
// matched the raw message its own way, and a message nobody had listed
// ("Connection timeout", "Unexpected socket close") stopped a campaign
// that the next minute would have sent.
//
// Every code answers the two questions that decide what happens next:
//
//   tillfälligt  will the same send likely work in a minute? Then a
//                campaign tries again instead of pausing.
//   föreBrev     did it fail where Gmail cannot have taken the letter?
//                Only then may the campaign's draft be released and the
//                ad tried again. A connection lost mid-send is not: the
//                letter may have arrived, and a retry would be a second.
//
// Gmail answering with an error code (4xx/5xx) means it did NOT accept
// the letter, whatever stage it was at. Only a connection that dies
// without an answer leaves the outcome unknown.
//
// First match wins, so the specific rules come before the general ones.
// ------------------------------------------------------------
const text = (err) => `${err?.message || ''} ${err?.response || ''}`;
const NÄTET_NÅDDES_INTE = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|Connection timeout|Greeting never received|Unexpected socket close/;
const ANSLUTNINGEN_DOG = /ECONNRESET|EPIPE|socket hang up|Connection closed|ETLS|(^|: )Timeout\b/;
const DATABASEN = /EMAXCONNSESSION|ECIRCUITBREAKER|Connection terminated|terminating connection|too many clients|timeout exceeded when trying to connect/i;

export const MEJLFEL = [
  {
    kod: 'MAIL_NOT_CONNECTED', tillfälligt: false, föreBrev: true,
    text: 'Gmail är inte kopplat — lägg in ett applösenord under Profil',
    test: (e) => e?.code === 'GMAIL_SAKNAS',
  },
  {
    kod: 'MAIL_LOGIN_REJECTED', tillfälligt: false, föreBrev: true,
    text: 'Gmail godtog inte inloggningen — kontrollera applösenordet under Profil',
    test: (e) => e?.code === 'EAUTH' || e?.responseCode === 535,
  },
  {
    kod: 'MAIL_SEND_LIMIT', tillfälligt: false, föreBrev: true,
    text: 'Gmails gräns för utskick är nådd — försök igen i morgon',
    test: (e) => /5\.4\.5|sending limit|limit exceeded/i.test(text(e)),
  },
  {
    kod: 'MAIL_RATE_LIMITED', tillfälligt: true, föreBrev: true,
    text: 'Gmail ber oss vänta en stund',
    test: (e) => e?.responseCode === 421 || /4\.7\.0|try again later/i.test(text(e)),
  },
  {
    kod: 'MAIL_RECIPIENT_REJECTED', tillfälligt: false, föreBrev: true,
    text: 'mottagarens server avvisade adressen',
    test: (e) => e?.code === 'EENVELOPE'
      || /all recipients were rejected|5\.1\.[13]|5\.5\.2|\b55[035]\b/.test(text(e)),
  },
  {
    kod: 'MAIL_REJECTED', tillfälligt: false, föreBrev: true,
    text: 'Gmail tog inte emot brevet',
    test: (e) => e?.responseCode >= 400,
  },
  {
    kod: 'MAIL_CONNECT_FAILED', tillfälligt: true, föreBrev: true,
    text: 'kom inte fram till Gmail',
    test: (e) => NÄTET_NÅDDES_INTE.test(text(e)),
  },
  {
    kod: 'MAIL_CONNECTION_LOST', tillfälligt: true, föreBrev: false,
    text: 'anslutningen till Gmail bröts mitt i',
    test: (e) => e?.code === 'ESOCKET' || e?.code === 'ECONNECTION' || e?.code === 'ETIMEDOUT'
      || ANSLUTNINGEN_DOG.test(text(e)),
  },
  {
    // The database, not Gmail. Mostly before the send (the account is
    // read first), but the row is written after it, so not föreBrev.
    kod: 'DB_UNAVAILABLE', tillfälligt: true, föreBrev: false,
    text: 'databasen svarade inte',
    test: (e) => DATABASEN.test(`${e?.code || ''} ${text(e)}`),
  },
  {
    kod: 'MAIL_UNKNOWN', tillfälligt: false, föreBrev: false,
    text: 'okänt fel vid utskick',
    test: () => true,
  },
];

// { kod, tillfälligt, föreBrev, text, detalj } for any error a send threw.
export function mejlfel(err) {
  const regel = MEJLFEL.find((r) => r.test(err));
  return {
    kod: regel.kod, tillfälligt: regel.tillfälligt, föreBrev: regel.föreBrev, text: regel.text,
    detalj: String(err?.message || err).slice(0, 200),
  };
}

export const FÖRE_BREV = MEJLFEL.filter((r) => r.föreBrev).map((r) => r.kod);
export const TILLFÄLLIGA = MEJLFEL.filter((r) => r.tillfälligt).map((r) => r.kod);

// A route's answer for a failed send: the user reads the text, the code
// is for whoever has to find out why. An error no rule knows is often
// one of ours with words already meant for the user ("annonsen saknar
// ansöknings-mejl"), so its own message is kept rather than replaced.
export function felsvar(err) {
  const f = mejlfel(err);
  const text = f.kod === 'MAIL_UNKNOWN' ? f.detalj : f.text;
  return { error: `${text} (${f.kod})`, kod: f.kod, detalj: f.detalj };
}
