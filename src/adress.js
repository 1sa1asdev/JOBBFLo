import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { inloggningsläge } from './authMode.js';

// ------------------------------------------------------------
// Which addresses the server may call on a user's behalf.
//
// LM Studio and Ollama take a base URL from the user, and the server
// then fetches it: the model list, the connection test, every call.
// Without a check that is a way to make the server fetch anything it
// can reach — localhost, the host's metadata service (169.254.169.254
// hands out cloud credentials), the private network behind it. Any
// signed-in user could point "their model" there.
//
// So with login on — the hosted app, and the local multi-user test
// mode — an address must be https and must resolve only to public
// addresses. Without login it is one person on their own machine, where
// a model on localhost is the whole point, and anything goes.
//
// Checked again at call time, not only when saved: a hostname can be
// re-pointed after it was accepted.
// ------------------------------------------------------------

// IPv4 ranges that are not the public internet.
const PRIVATA_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const tal = (ip) => ip.split('.').reduce((n, d) => n * 256 + Number(d), 0);
function privatV4(ip) {
  const n = tal(ip);
  return PRIVATA_V4.some(([bas, bitar]) => {
    const storlek = 2 ** (32 - bitar);
    return Math.floor(n / storlek) === Math.floor(tal(bas) / storlek);
  });
}
function privatV6(ip) {
  const a = ip.toLowerCase();
  if (a === '::' || a === '::1') return true;
  // An IPv4 address wrapped in IPv6 is that IPv4 address. new URL()
  // rewrites [::ffff:127.0.0.1] to [::ffff:7f00:1], so both spellings.
  const mappad = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappad) return privatV4(mappad[1]);
  const hex = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
    return privatV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  // fc00::/7 unique local, fe80::/10 link local, ff00::/8 multicast
  return /^(fc|fd|fe[89ab]|ff)/.test(a);
}
export const privatAdress = (ip) => (isIP(ip) === 4 ? privatV4(ip) : isIP(ip) === 6 ? privatV6(ip) : true);

// null when the server may call it; otherwise why not, in Swedish, for
// the user. `strikt` defaults to "login is on"; slåUpp is there so the
// proof can resolve names without the network.
export async function prövaAdress(url, { strikt = inloggningsläge() !== 'av', slåUpp = lookup } = {}) {
  let u;
  try { u = new URL(String(url || '')); } catch { return 'Adressen går inte att läsa — skriv den som https://…'; }
  if (!['http:', 'https:'].includes(u.protocol)) return 'Bara http- och https-adresser går att använda.';
  if (!strikt) return null;

  if (u.protocol !== 'https:') return 'Adressen måste börja med https:// — servern skickar inte trafik okrypterat.';
  if (u.username || u.password) return 'Adressen får inte innehålla användarnamn eller lösenord.';
  const värd = u.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(värd)) {
    return 'Servern kan inte nå din dator via localhost. Använd en publik https-adress, till exempel en tunnel till LM Studio eller Ollama.';
  }
  let adresser;
  try {
    adresser = isIP(värd) ? [värd] : (await slåUpp(värd, { all: true })).map((a) => a.address);
  } catch {
    return `Hittar inte ${värd}.`;
  }
  if (!adresser.length || adresser.some(privatAdress)) {
    return 'Adressen pekar på ett privat eller internt nät, som servern inte får anropa åt dig.';
  }
  return null;
}
