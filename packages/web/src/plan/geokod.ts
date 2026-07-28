/**
 * "Vart?" — adressökningen.
 *
 * Photon (photon.komoot.io) FÖRST, och inte Nominatim: Nominatims usage policy
 * förbjuder uttryckligen autocomplete. Photon är byggt för det och är nyckellöst.
 *
 * Nominatim finns ändå här — som RESERV när Photon ligger nere (skarpt fall
 * 2026-07-28: photon.komoot.io vägrade TCP-anslutningar globalt i timmar, och appens
 * enda geokodare var en enpunktstjänst). Reserven är byggd för att hålla sig inom
 * Nominatims policy: den fyrar bara när Photon redan misslyckats med en FÄRDIG fråga
 * (aldrig per tangenttryckning), och en strypare garanterar >1 s mellan anropen.
 *
 * Två fällor, båda skarpt verifierade:
 *   · `countrycode=se`  — SINGULAR. `countrycodes` ger HTTP 400.
 *   · `lang=default`    — `lang=sv` ger HTTP 400. Photon kan inte svenska, och det gör
 *                         ingenting: ortnamnen i Sverige ÄR svenska i OSM.
 *
 * Reverse-geokodning görs inte under körning. Vägnamn kommer ur ruttmotorns manövrar
 * (`streetRef`), aldrig ur en geokodare — Nominatims policy stryper återkommande skript
 * till 4 anrop i minuten, och en enda aktiv förare bryter mot den.
 *
 * Undantaget är `varJagÄr`: ETT anrop när planeringsarket öppnas på en virtuell resa,
 * mot Photon (nyckellös, byggd för last), aldrig i loop. Se motiveringen vid funktionen.
 */

import type { LngLat } from '@mindful/core';

const PHOTON = 'https://photon.komoot.io/api/';

/** Fler än så är en lista man läser i stället för väljer ur. */
const ANTAL = 6;

/** En tangenttryckning är inte en fråga. 350 ms är den tid det tar att sluta skriva. */
export const DEBOUNCE_MS = 350;

export interface Plats {
  readonly id: string;
  /** "Kalmar". Det man känner igen. */
  readonly namn: string;
  /** "Kalmar kommun, Kalmar län". Det som skiljer två med samma namn åt. Kan vara tom. */
  readonly beskrivning: string;
  readonly at: LngLat;
}

interface PhotonEgenskaper {
  readonly osm_id?: number;
  readonly osm_type?: string;
  readonly name?: string;
  readonly street?: string;
  readonly housenumber?: string;
  readonly postcode?: string;
  readonly city?: string;
  readonly district?: string;
  readonly county?: string;
  readonly state?: string;
}

interface PhotonSvar {
  readonly features?: ReadonlyArray<{
    readonly properties?: PhotonEgenskaper;
    readonly geometry?: { readonly coordinates?: readonly number[] };
  }>;
}

/**
 * Namnet: ortens namn om den har ett, annars adressen. En träff utan endera är en träff
 * användaren inte kan känna igen, och den kastas i `sök`.
 */
function namnAv(p: PhotonEgenskaper): string {
  if (p.name) return p.name;
  if (p.street) return p.housenumber ? `${p.street} ${p.housenumber}` : p.street;
  return '';
}

/** Raden under namnet. Dubbletter tas bort — "Kalmar, Kalmar" hjälper ingen. */
function beskrivningAv(p: PhotonEgenskaper, namn: string): string {
  const delar: string[] = [];
  for (const del of [p.city, p.district, p.county, p.state]) {
    const d = del?.trim();
    if (d && d !== namn && !delar.includes(d)) delar.push(d);
  }
  return delar.slice(0, 2).join(', ');
}

/**
 * Nominatims absoluta tak är 1 anrop/sekund. Strypningen är global för modulen: den
 * gäller sök OCH reverse tillsammans, för det är samma tjänst som räknar.
 */
let nominatimSenast = 0;

async function vänteläge(signal?: AbortSignal): Promise<void> {
  const kvar = nominatimSenast + 1_100 - Date.now();
  if (kvar > 0) await new Promise((r) => setTimeout(r, kvar));
  if (signal?.aborted) throw new DOMException('avbruten', 'AbortError');
  nominatimSenast = Date.now();
}

interface NominatimTräff {
  readonly place_id?: number;
  readonly name?: string;
  readonly display_name?: string;
  readonly lon?: string;
  readonly lat?: string;
}

/** Reserven. Bara hela frågor, bara efter att Photon svikit, aldrig i debounce-takt. */
async function sökNominatim(q: string, signal?: AbortSignal): Promise<Plats[]> {
  await vänteläge(signal);

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('countrycodes', 'se');   // ⚠️ PLURAL här — tvärtom mot Photon.
  url.searchParams.set('limit', String(ANTAL));

  const svar = await fetch(url, signal ? { signal } : {});
  if (!svar.ok) throw new Error('Sökningen svarade inte.');

  const träffar = (await svar.json()) as NominatimTräff[];
  const platser: Plats[] = [];

  for (const t of träffar) {
    const lon = Number(t.lon);
    const lat = Number(t.lat);
    const namn = t.name?.trim() ?? '';
    if (!namn || !Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    const resten = (t.display_name ?? '')
      .split(',')
      .map((d) => d.trim())
      .filter((d) => d && d !== namn && d !== 'Sverige');

    platser.push({
      id: `nom-${t.place_id ?? platser.length}`,
      namn,
      beskrivning: resten.slice(0, 2).join(', '),
      at: [lon, lat],
    });
  }
  return platser;
}

/**
 * Sök. `nära` är valfri och biasar träffarna mot där man står — det är nästan alltid
 * rätt: man söker på "handelsboden", inte på "handelsboden i Kalmar".
 *
 * Photon först; sviker den (nätfel eller felstatus) tar Nominatim-reserven frågan.
 */
export async function sök(
  fråga: string,
  nära?: LngLat,
  signal?: AbortSignal,
): Promise<Plats[]> {
  const q = fråga.trim();
  if (q.length < 2) return [];

  try {
    return await sökPhoton(q, nära, signal);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    return sökNominatim(q, signal);
  }
}

async function sökPhoton(
  q: string,
  nära?: LngLat,
  signal?: AbortSignal,
): Promise<Plats[]> {
  const url = new URL(PHOTON);
  url.searchParams.set('q', q);
  url.searchParams.set('lang', 'default');
  url.searchParams.set('countrycode', 'se');
  url.searchParams.set('limit', String(ANTAL));
  if (nära) {
    url.searchParams.set('lon', nära[0].toFixed(5));
    url.searchParams.set('lat', nära[1].toFixed(5));
  }

  const svar = await fetch(url, { signal });
  if (!svar.ok) throw new Error('Sökningen svarade inte.');

  const kropp = (await svar.json()) as PhotonSvar;
  const platser: Plats[] = [];

  for (const f of kropp.features ?? []) {
    const p = f.properties;
    const c = f.geometry?.coordinates;
    const lon = c?.[0];
    const lat = c?.[1];
    if (!p || typeof lon !== 'number' || typeof lat !== 'number') continue;

    const namn = namnAv(p);
    if (!namn) continue;

    platser.push({
      id: `${p.osm_type ?? '?'}${p.osm_id ?? platser.length}`,
      namn,
      beskrivning: beskrivningAv(p, namn),
      at: [lon, lat],
    });
  }

  return platser;
}

/**
 * Var står jag? Ortens namn för en punkt — den virtuella resans fråga, inte bilens.
 *
 * I en bil vet man var man är; på en virtuell resa är positionen OSYNLIG, och den står
 * kvar där förra resan slutade. Skarpt fall: operatören planerade "Åhus" och fick en
 * omvägsbudget på högst 30 minuter — obegripligt från Lund, självklart från Kivik, där
 * förra resan gick i mål. En rad med ortnamnet gör tillståndet synligt i stället för
 * överraskande.
 *
 * `null` vid varje slags miss: raden är en artighet, aldrig något planeringen väntar på.
 */
export async function varJagÄr(at: LngLat, signal?: AbortSignal): Promise<string | null> {
  try {
    const url = new URL('https://photon.komoot.io/reverse');
    url.searchParams.set('lon', at[0].toFixed(5));
    url.searchParams.set('lat', at[1].toFixed(5));
    url.searchParams.set('lang', 'default');

    const svar = await fetch(url, signal ? { signal } : {});
    if (!svar.ok) throw new Error(String(svar.status));

    const kropp = (await svar.json()) as PhotonSvar;
    const p = kropp.features?.[0]?.properties;
    return p ? (p.city ?? p.name ?? null) : null;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
  }

  // Reserven, samma strypare som söket. Raden är fortfarande bara en artighet.
  try {
    await vänteläge(signal);
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.searchParams.set('lon', at[0].toFixed(5));
    url.searchParams.set('lat', at[1].toFixed(5));
    url.searchParams.set('format', 'jsonv2');

    const svar = await fetch(url, signal ? { signal } : {});
    if (!svar.ok) return null;

    const kropp = (await svar.json()) as {
      name?: string;
      address?: { city?: string; town?: string; village?: string };
    };
    return kropp.address?.city ?? kropp.address?.town ?? kropp.address?.village
      ?? kropp.name ?? null;
  } catch {
    return null;
  }
}
