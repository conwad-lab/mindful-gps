/**
 * Rösten när servern tiger — webbläsarens egen talsyntes.
 *
 * ⛔ ENDAST fallback (CONTRACT §6). ElevenLabs på servern är primärvägen när den är
 *    påslagen. Den här filen finns för att en berättelse man inte kan HÖRA är en
 *    berättelse man inte får ta del av med blicken på vägen — och en gratis robotröst
 *    är oändligt mycket bättre än tystnad. Fallback-vägen är komplett i sig själv.
 *
 * Tre saker slår CONTRACT §6 fast, och som den här filen därför gör:
 *
 *  1. `getVoices()` LJUGER. Den är tom vid första anropet i Chrome och fylls först när
 *     `voiceschanged` kommit. Vi värmer cachen vid import och läser ur den sedan —
 *     synkront, av skäl 3.
 *
 *  2. Whitelista `sv-SE`, normalisera `sv_SE` → `sv-SE`. Plattformarna är oense om
 *     avgränsaren, och vissa skickar bara "sv".
 *
 *  3. Watchdog. Kommer inte `onend` inom estimerad tid × 2 → `cancel()`. Talsyntesen
 *     HÄNGER SIG på iOS om appen bakgrundas mitt i en mening, och en hängd motor tar
 *     nästa uppläsning med sig i graven.
 *
 * ⚠️ Uppläsningen startas SYNKRONT, i användarens knapptryck. iOS kräver en
 *    användargest för att låta talsyntesen ljuda, och ett `await` mot servern före
 *    `speak()` bryter den kedjan. Därför cachas röstvalet i modulen i stället för att
 *    hämtas när det behövs.
 *
 * ⚠️ Texten talas mening för mening, som köade utterances — inte som en enda lång.
 *    Chrome tystnar mitt i utterances längre än ~15 s, och en tvåmeningarsberättelse
 *    ligger över det. Prosodin bevaras ändå: doktrinens förbud gäller konkatenerade
 *    FRAGMENT ("sväng" + "vänster"), inte hela meningar lästa i följd.
 */

/** Svenskt tal ligger kring det här i normal takt. Används bara för watchdog-tiden. */
const TECKEN_PER_SEKUND = 14;

/** Även en tvåordsmening ska hinna sägas innan vakten slår till. */
const MINSTA_VAKTTID_MS = 5_000;

/** Taket för hur länge vi väntar in `voiceschanged` innan vi nöjer oss med förvalet. */
const VÄNTA_RÖSTER_MS = 3_000;

let svenskRöst: SpeechSynthesisVoice | null = null;
let vakt: ReturnType<typeof setTimeout> | null = null;
let avsiktligtAvbrutet = false;

/** Finns motorn över huvud taget? Äldre webbläsare och vissa inbäddade vyer saknar den. */
export function finnsTalsyntes(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/** `sv_SE`, `sv-SE`, `SV-se` → `sv-se`. Plattformarna är oense; vi är det inte. */
function normaliserad(lang: string): string {
  return lang.replace('_', '-').toLowerCase();
}

/** Whitelistan: exakt `sv-SE` först, annars vilken svenska som helst. */
function väljSvensk(röster: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const svenska = röster.filter((r) => normaliserad(r.lang).startsWith('sv'));
  if (svenska.length === 0) return null;
  return svenska.find((r) => normaliserad(r.lang) === 'sv-se') ?? svenska[0] ?? null;
}

/**
 * Värm röstcachen. Anropas vid import — `getVoices()` är tom i Chrome tills motorn är
 * klar, och vi vill ha svaret färdigt när fingret träffar knappen.
 */
export function värmRöster(): void {
  if (!finnsTalsyntes()) return;

  const försök = (): boolean => {
    const röster = window.speechSynthesis.getVoices();
    if (röster.length === 0) return false;
    svenskRöst = väljSvensk(röster);
    return true;
  };

  if (försök()) return;

  const lyssnare = (): void => { försök(); };
  window.speechSynthesis.addEventListener('voiceschanged', lyssnare);
  // Kommer händelsen aldrig (Safari fyller listan utan att säga till) släpper vi ändå
  // taget — förvalsrösten duger, och en lyssnare som ligger kvar för alltid är en läcka.
  setTimeout(() => {
    försök();
    window.speechSynthesis.removeEventListener('voiceschanged', lyssnare);
  }, VÄNTA_RÖSTER_MS);
}

/** Meningarna, i tur och ordning. Tom text ger en tom lista, inte en tom mening. */
function meningar(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
}

/** Talar vi just nu? Frågar motorn, inte vårt eget minne — den kan ha tystnat själv. */
export function talar(): boolean {
  return finnsTalsyntes() && window.speechSynthesis.speaking;
}

/** Avbryt pågående uppläsning. Tyst no-op om ingenting talar. */
export function avbrytLokalt(): void {
  if (!finnsTalsyntes()) return;
  avsiktligtAvbrutet = true;
  släppVakt();
  window.speechSynthesis.cancel();
}

function släppVakt(): void {
  if (vakt !== null) {
    clearTimeout(vakt);
    vakt = null;
  }
}

interface Händelser {
  readonly onSlut: () => void;
  readonly onFel: (meddelande: string) => void;
}

/**
 * Läs upp texten med webbläsarens röst. SYNKRON med flit — se filhuvudet.
 *
 * Returnerar `false` om motorn saknas, så anroparen kan säga något ärligt i stället för
 * att visa en knapp som inte gör något.
 */
export function läsUppLokalt(text: string, händelser: Händelser): boolean {
  if (!finnsTalsyntes()) return false;

  const stycken = meningar(text);
  if (stycken.length === 0) return false;

  // En hängd motor från förra uppläsningen tar den här med sig. Städa först.
  avsiktligtAvbrutet = true;
  window.speechSynthesis.cancel();
  avsiktligtAvbrutet = false;
  släppVakt();

  stycken.forEach((mening, i) => {
    const yttrande = new SpeechSynthesisUtterance(mening);
    if (svenskRöst) yttrande.voice = svenskRöst;
    // Sätts även när rösten saknas: utan `lang` läser en engelsk förvalsröst svenskan
    // som om den vore engelska, vilket är obegripligt snarare än bara robotaktigt.
    yttrande.lang = 'sv-SE';

    if (i === stycken.length - 1) {
      yttrande.onend = () => {
        släppVakt();
        händelser.onSlut();
      };
    }

    yttrande.onerror = (h) => {
      // `canceled` / `interrupted` är VÅRT eget avbrott — inte ett fel att visa.
      if (avsiktligtAvbrutet || h.error === 'canceled' || h.error === 'interrupted') return;
      släppVakt();
      händelser.onFel('Webbläsarens röst kunde inte läsa upp.');
    };

    window.speechSynthesis.speak(yttrande);
  });

  // Watchdog: hinner motorn inte bli klar på dubbla den estimerade tiden har den hängt
  // sig (iOS, bakgrundad app). Avbryt, så nästa tryck möter en ren motor.
  const estimatMs = Math.max((text.length / TECKEN_PER_SEKUND) * 1000, MINSTA_VAKTTID_MS);
  vakt = setTimeout(() => {
    vakt = null;
    if (!window.speechSynthesis.speaking) return;
    avsiktligtAvbrutet = true;
    window.speechSynthesis.cancel();
    händelser.onSlut();
  }, estimatMs * 2);

  return true;
}

värmRöster();
