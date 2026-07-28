/**
 * Curiosa — sevärdheterna längs rutten, i den ordning man passerar dem.
 *
 * Urvalet görs på servern (`POST /api/sight/langs`), inte här. Rutten Lund → Simrishamn
 * spänner ett tiotal kartrutor och tusentals sevärdheter; att hämta hem alla för att
 * sedan kasta 99 % av dem vore att flytta en PostGIS-fråga till en telefon.
 */

import type { LngLat, SightKind } from '@mindful/core';

const API = import.meta.env['VITE_API'] ?? 'http://localhost:8161';

export interface Curiosum {
  readonly id: number;
  readonly kind: SightKind;
  /** Kan vara tom. En namnlös runsten är fortfarande värd att stanna vid. */
  readonly name: string;
  readonly at: LngLat;
  /** Sträckan in på rutten där den ligger, meter. Resans hela ordningsbegrepp. */
  readonly alongM: number;
}

/**
 * Curiosa längs en rutt.
 *
 * Ett nätfel ger en TOM resa, inte ett kastat fel: en virtuell resa utan curiosa är
 * fortfarande en resa — man ser landskapet dra förbi — medan en resa som vägrar starta
 * för att en sevärdhetsfråga sviktade är ingenting alls.
 */
export async function curiosaLängs(
  polyline: string, signal?: AbortSignal,
): Promise<Curiosum[]> {
  try {
    const res = await fetch(`${API}/api/sight/langs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ polyline }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return [];

    const { curiosa } = await res.json() as { curiosa?: Curiosum[] };
    return curiosa ?? [];
  } catch {
    return [];
  }
}

/**
 * Värm berättelsecachen för EXAKT de valda curiosa, i bakgrunden.
 *
 * Resan använder den här i stället för den generiska `/sight/prefetch`: prefetchen
 * väljer efter körningens vikter och värmer upp till tolv texter, varav de flesta inte
 * är resans stopp. Att komponera just de sex vi ska stanna vid är både billigare och
 * träffsäkrare. Fire-and-forget — ett stopp vars text inte hann bli klar hämtar den
 * live medan resan står still, vilket är exakt rätt ögonblick att vänta i.
 */
export function värmCuriosa(curiosa: readonly Curiosum[]): void {
  for (const c of curiosa) {
    void fetch(`${API}/api/sight/${c.id}/berattelse`).catch(() => { /* tyst */ });
  }
}
