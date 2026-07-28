/**
 * Den virtuella resan — att resa hemifrån, i curiosa-tempo.
 *
 * ── Vad den är ──────────────────────────────────────────────────────────────
 *
 * Sätt start och mål, tryck kör, och res sträckan från soffan. Landskapet drar förbi på
 * kartan, och vid varje sevärdhet STANNAR resan, berättar, och fortsätter sedan.
 *
 * ── Curiosa-tempo, och varför det inte är km/h ──────────────────────────────
 *
 * Fartreglaget i simläget tänker i "hur många gånger snabbare än verkligheten". Det är
 * rätt fråga när man testar navigering och fel fråga när man reser: den som sitter
 * hemma bryr sig inte om hur fort kartan rullar, bara hur ofta det händer något.
 *
 * Tempot är därför SEKUNDER MELLAN CURIOSA. Vi vet var nästa sevärdhet ligger, vi vet
 * simulatorns fart — alltså kan vi räkna ut hur mycket väggklockan behöver komprimeras
 * för att just den sträckan ska ta ungefär den tid resenären bad om. En mil ödemark
 * går fort; tätt mellan runstenarna går långsamt. Resan andas.
 *
 * ── Doktrinen, och var gränsen går ──────────────────────────────────────────
 *
 * ⛔ Appen berättar ALDRIG oombett — utom här, och det är hela skillnaden mellan de två
 *    lägena. Doktrinen skyddar en FÖRARES uppmärksamhet: ett blad som slår upp sig
 *    självt i 90 km/h är en olycka. I soffan finns ingen väg att titta bort från, och en
 *    resa där man själv måste trycka på varje prick är inte en resa utan en meny.
 *
 * ⛔ Därför kan läget ALDRIG nås i skarpt läge. `resaOptionsFromUrl` kräver `?sim=1`,
 *    och kontrollern rör bara en `SimGeoProvider`. En riktig GPS går inte att pausa,
 *    och den dagen någon försöker vill vi att det ska vara omöjligt, inte olämpligt.
 */

import { decode6, length, projectOnPolyline, type LngLat, type Polyline6 } from '@mindful/core';

import {
  MAX_SIM_FART, pausaSim, simFartMs, sättSimFart, återupptaSim,
  type Fix, type GeoProvider, type Recorder,
} from '../sense/index.js';

import type { Curiosum } from './curiosa.js';

/**
 * Så nära ett curiosum resan stannar.
 *
 * 150 m, inte 20: fixarna bär GPS-brus även i simulatorn, och i hög takt hoppar
 * positionen hundratals meter mellan två fixar. En snävare tröskel hade gjort att resan
 * ibland susade förbi en runsten utan att stanna — och det utan att något såg fel ut.
 */
const NÄRA_M = 150;

/**
 * Längsta tid resan får stå still vid ett curiosum innan den fortsätter av sig själv.
 *
 * Vakten finns för att uppläsningen kan svika på sätt vi inte äger: en talsyntes som
 * hänger sig, ett `onend` som aldrig kommer, en flik som bakgrundats. Utan den vore en
 * tyst röst detsamma som en resa som aldrig tar slut.
 */
const MAX_STOPP_MS = 120_000;

/**
 * Så nära spårets slut resan räknar sig som framme.
 *
 * 100 m: sista fixen landar på spårets slutpunkt plus GPS-brus, och projektionen mot
 * ruttens polyline kan skilja några meter från simspårets. Snävare hade riskerat en
 * resa som står 30 m från målet och aldrig blir klar — utan att något ser fel ut.
 */
const FRAMME_M = 100;

/** Tempot resan börjar i, sekunder mellan curiosa. */
export const TEMPO_START_S = 90;
export const TEMPO_MIN_S = 15;
export const TEMPO_MAX_S = 300;

export interface ResaHändelser {
  /** Resan stannade vid ett curiosum. Visa bladet och läs upp det. */
  readonly onCuriosum: (c: Curiosum, nummer: number, av: number) => void;
  /** Resan rullar igen — bladet kan stängas. */
  readonly onFortsätter: () => void;
  /**
   * Spåret tog slut — resan är framme och avslutar sig själv.
   *
   * ⛔ BARA resläget. I en riktig körning avgör föraren när turen är slut ("Håll in
   *    för att avsluta") — appen gissar aldrig åt en människa som sitter i en bil.
   *    En virtuell resa har inget sådant omdöme att respektera: när spåret är slut
   *    finns det bokstavligen ingenting mer som kan hända, och en skärm som står och
   *    väntar på ett håll-in-tryck är en resa som glömde gå i mål.
   */
  readonly onFramme: () => void;
}

export class VirtuellResa {
  readonly #geo: GeoProvider;
  readonly #recorder: Recorder;
  readonly #händelser: ResaHändelser;
  readonly #spår: readonly LngLat[];
  readonly #spårLängdM: number;
  readonly #curiosa: readonly Curiosum[];

  #tempoS: number;
  #index = 0;
  #alongM = 0;
  #stannad = false;
  /** Framme-händelsen får bara fyras EN gång — avslutet river resan asynkront. */
  #framme = false;
  #vakt: ReturnType<typeof setTimeout> | null = null;
  #avreg: (() => void) | null = null;

  constructor(
    geo: GeoProvider,
    recorder: Recorder,
    geometry: Polyline6,
    curiosa: readonly Curiosum[],
    händelser: ResaHändelser,
    tempoS: number = TEMPO_START_S,
  ) {
    this.#geo = geo;
    this.#recorder = recorder;
    this.#spår = decode6(geometry);
    this.#spårLängdM = length(this.#spår);

    // ⚠️ Räkna om alongM i VÅR metrik. Serverns tal kommer ur PostGIS geography
    //    (WGS84-ellipsoid); vårt ur haversine (sfär). Skillnaden är ~0,3 % — 250 m på
    //    en 8-milarutt — och ett curiosum i ruttens sista bit kan då ligga BORTOM allt
    //    vi någonsin mäter, och hoppas över tyst. MÄTT: Lund → Kivik slutade "5 av 6".
    //    Serverns alongM styr fortfarande urval och ordning; här styr det META, och då
    //    måste linjalen vara vår egen.
    this.#curiosa = curiosa
      .map((c) => ({
        ...c,
        alongM: projectOnPolyline(c.at, this.#spår)?.alongM ?? c.alongM,
      }))
      .sort((a, b) => a.alongM - b.alongM);
    this.#händelser = händelser;
    this.#tempoS = tempoS;
  }

  get tempoS(): number {
    return this.#tempoS;
  }

  /** Hur många curiosa som passerats, och hur många det finns. För en lugn rad i UI:t. */
  get räkning(): { readonly passerade: number; readonly av: number } {
    return { passerade: this.#index, av: this.#curiosa.length };
  }

  /** Står resan still vid ett curiosum just nu? */
  get stannad(): boolean {
    return this.#stannad;
  }

  start(): void {
    if (this.#avreg) return;
    this.#avreg = this.#recorder.on('fix', (f) => { this.#påFix(f); });
    this.#sättTakt();
  }

  /** Nytt tempo mitt i resan. Slår igenom på sträckan som pågår, inte bara nästa. */
  sättTempo(sekunder: number): void {
    this.#tempoS = Math.min(TEMPO_MAX_S, Math.max(TEMPO_MIN_S, sekunder));
    if (!this.#stannad) this.#sättTakt();
  }

  /**
   * Fortsätt efter ett curiosum.
   *
   * Idempotent med flit: berättelsen kan ta slut samtidigt som resenären stänger bladet,
   * och två anrop ska inte ge dubbel fart.
   */
  fortsätt(): void {
    if (!this.#stannad) return;
    this.#stannad = false;
    this.#släppVakt();
    this.#sättTakt();
    återupptaSim(this.#geo);
    this.#händelser.onFortsätter();
  }

  stoppa(): void {
    this.#avreg?.();
    this.#avreg = null;
    this.#släppVakt();
    this.#stannad = false;
  }

  #släppVakt(): void {
    if (this.#vakt !== null) {
      clearTimeout(this.#vakt);
      this.#vakt = null;
    }
  }

  #påFix(f: Fix): void {
    if (this.#stannad) return;

    // Var på rutten är vi? Projektionen, inte fågelvägen: en resa mäts längs vägen, och
    // ett curiosum tvärs över en vik kan ligga hundra meter bort men fem kilometer bort
    // att köra.
    const träff = projectOnPolyline([f.lon, f.lat], this.#spår);
    if (!träff) return;
    this.#alongM = träff.alongM;

    // Passerade curiosa räknas av. I hög takt kan ett helt hoppas över mellan två
    // fixar — då ska resan inte stanna vid något som redan ligger bakom.
    while (this.#index < this.#curiosa.length) {
      const c = this.#curiosa[this.#index];
      if (c === undefined) break;

      if (this.#alongM >= c.alongM - NÄRA_M) {
        this.#stanna(c);
        return;
      }
      break;
    }

    // Spårets slut, och inget curiosum tog fixen före oss (ett stopp vid målet vinner:
    // det checkas ovan och returnerar). Ligger vi stannade vid ett curiosum kommer vi
    // inte hit alls — och simulatorn skickar en ny sista fix efter `fortsätt()`, så
    // framme-checken får alltid ett andra försök.
    if (!this.#framme && this.#alongM >= this.#spårLängdM - FRAMME_M) {
      this.#framme = true;
      this.#händelser.onFramme();
    }
  }

  #stanna(c: Curiosum): void {
    this.#stannad = true;
    this.#index += 1;
    pausaSim(this.#geo);

    this.#vakt = setTimeout(() => {
      this.#vakt = null;
      // Rösten svek, eller ingen lyssnade. Resan fortsätter ändå — den får aldrig bli
      // stående för att något vi inte äger tystnade.
      this.fortsätt();
    }, MAX_STOPP_MS);

    this.#händelser.onCuriosum(c, this.#index, this.#curiosa.length);
  }

  /**
   * Komprimera väggklockan så att sträckan fram till nästa curiosum tar ungefär
   * `tempoS` sekunder.
   *
   *   simulerade sekunder = kvarvarande meter / farten
   *   fart som multipel   = simulerade sekunder / önskad väggklockstid
   *
   * Finns inget curiosum kvar räcker det med maxfart — det som återstår är resan hem,
   * och den behöver ingen att stanna vid.
   */
  #sättTakt(): void {
    const fartMs = simFartMs(this.#geo);
    if (fartMs <= 0) return;

    const nästa = this.#curiosa[this.#index];
    if (nästa === undefined) {
      sättSimFart(this.#geo, MAX_SIM_FART);
      return;
    }

    const kvarM = Math.max(1, nästa.alongM - this.#alongM);
    const simSekunder = kvarM / fartMs;
    sättSimFart(this.#geo, simSekunder / this.#tempoS);
  }
}
