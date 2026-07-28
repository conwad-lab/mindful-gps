/**
 * Den virtuella resan — att resa hemifrån i curiosa-tempo.
 *
 * ⛔ Läget kräver `?sim=1`. Se `VirtuellResa.ts` för varför gränsen mot skarpt läge är
 *    absolut och inte en lämplighetsfråga.
 */

export { curiosaLängs, type Curiosum } from './curiosa.js';
export {
  VirtuellResa, TEMPO_START_S, TEMPO_MIN_S, TEMPO_MAX_S, type ResaHändelser,
} from './VirtuellResa.js';

import { isSimulated } from '../sense/index.js';
import { TEMPO_MAX_S, TEMPO_MIN_S, TEMPO_START_S } from './VirtuellResa.js';

export interface ResaOptions {
  /** Sekunder mellan curiosa. */
  readonly tempoS: number;
}

/**
 * Resläget ur URL:en: `?sim=1&resa=1`, med valfritt `&curiosa=90`.
 *
 * ⛔ `?resa=1` ensamt räcker inte. Utan simulator finns ingen klocka att komprimera och
 *    ingen resa att pausa — och framför allt: en riktig körning ska aldrig kunna hamna
 *    i ett läge där appen slår upp berättelser av sig själv.
 */
export function resaOptionsFromUrl(search: string = location.search): ResaOptions | null {
  if (!isSimulated()) return null;

  const q = new URLSearchParams(search);
  if (q.get('resa') !== '1') return null;

  const rå = Number(q.get('curiosa'));
  const tempoS = Number.isFinite(rå) && rå > 0
    ? Math.min(TEMPO_MAX_S, Math.max(TEMPO_MIN_S, rå))
    : TEMPO_START_S;

  return { tempoS };
}

/** Är vi på virtuell resa? UI:t byter reglage på den, inget annat. */
export function ärVirtuellResa(): boolean {
  return resaOptionsFromUrl() !== null;
}
