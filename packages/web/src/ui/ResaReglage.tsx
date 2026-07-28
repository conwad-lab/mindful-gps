/**
 * Curiosa-tempot — reglaget för den virtuella resan (`?sim=1&resa=1`).
 *
 * ⛔ Ersätter fartreglaget i resläget, och ritas aldrig i skarpt läge.
 *
 * Det står SEKUNDER MELLAN CURIOSA, inte "40×". Den som testar navigering vill veta hur
 * mycket verkligheten är komprimerad; den som reser hemifrån vill veta hur ofta det
 * händer något. Samma väggklocka under, två helt olika frågor — och den här skärmen
 * ställer resenärens.
 */

import { useApp } from '../app/state.js';
import { TEMPO_MAX_S, TEMPO_MIN_S } from '../resa/index.js';

/** "var 90:e sekund" — men "varje sekund" och "var 2:a" när svenskan kräver det. */
function tempoText(sekunder: number): string {
  if (sekunder >= 60 && sekunder % 60 === 0) {
    const min = sekunder / 60;
    return min === 1 ? 'en curiosa i minuten' : `en curiosa var ${min}:e minut`;
  }
  return `en curiosa var ${sekunder}:e sekund`;
}

export function ResaReglage() {
  const tempoS = useApp((s) => s.resaTempoS);
  const sättResaTempo = useApp((s) => s.sättResaTempo);
  const { passerade, av } = useApp((s) => s.resaRäkning);

  return (
    <div className="simreglage">
      <span className="simreglage__val">
        {tempoText(tempoS)}
        {av > 0 && ` · ${passerade} av ${av}`}
      </span>
      <input
        type="range"
        min={TEMPO_MIN_S}
        max={TEMPO_MAX_S}
        step={15}
        value={tempoS}
        onChange={(e) => sättResaTempo(Number(e.target.value))}
        aria-label="Curiosa-tempo"
      />
    </div>
  );
}
