/**
 * OSM-taggar → våra tolv sorter.
 *
 * Ordningen i `REGLER` är en PRIORITET, inte en lista. En medeltida kyrka är taggad både
 * `historic=church` och `amenity=place_of_worship`, och en borgruin är både
 * `historic=castle` och `historic=ruins`. Första träffen vinner, och därför står det
 * ovanligare och mer sevärda överst: en runsten är alltid en runsten, aldrig ett
 * "minnesmärke".
 */

import type { SightKind } from '@mindful/core';

type Taggar = Readonly<Record<string, string>>;

interface Regel {
  readonly nyckel: string;
  readonly värden: readonly string[];
  readonly sort: SightKind;
}

const REGLER: readonly Regel[] = [
  { nyckel: 'historic',  värden: ['runestone', 'rune_stone'],            sort: 'runsten' },
  { nyckel: 'natural',   värden: ['waterfall'],                          sort: 'vattenfall' },
  { nyckel: 'tourism',   värden: ['viewpoint'],                          sort: 'utsikt' },
  { nyckel: 'man_made',  värden: ['lighthouse'],                         sort: 'fyr' },
  { nyckel: 'historic',  värden: ['castle', 'fort', 'city_gate'],        sort: 'borg' },
  { nyckel: 'historic',  värden: ['ruins'],                              sort: 'borg' },
  { nyckel: 'historic',  värden: ['archaeological_site', 'tomb',
                                  'boundary_stone', 'wayside_cross'],    sort: 'fornlämning' },
  { nyckel: 'leisure',   värden: ['nature_reserve'],                     sort: 'naturreservat' },
  { nyckel: 'boundary',  värden: ['protected_area'],                     sort: 'naturreservat' },
  { nyckel: 'historic',  värden: ['church', 'chapel', 'monastery'],      sort: 'kyrka' },
  { nyckel: 'tourism',   värden: ['museum'],                             sort: 'museum' },
  { nyckel: 'tourism',   värden: ['gallery'],                            sort: 'galleri' },
  { nyckel: 'craft',     värden: ['winery'],                             sort: 'vingård' },
  { nyckel: 'tourism',   värden: ['attraction', 'artwork'],              sort: 'sevärdhet' },
  { nyckel: 'historic',  värden: ['memorial', 'monument'],               sort: 'minnesmärke' },
];

/**
 * Kyrkan är ett specialfall och får sin egen rad.
 *
 * `amenity=place_of_worship` träffar också moskéer, synagogor och Pingstkyrkans lokal i
 * ett industriområde. Bara den som ÄR en byggnad värd att se från vägen räknas, och den
 * signalen finns i `building=church` eller `historic`. En modern församlingslokal är
 * ingen sevärdhet, hur mycket den än är ett gudshus.
 */
function ärSevärdKyrka(t: Taggar): boolean {
  if (t['amenity'] !== 'place_of_worship') return false;
  return t['building'] === 'church' || t['building'] === 'chapel' || t['historic'] !== undefined;
}

/**
 * Sorterna som bara räknas MED NAMN, av motsatt skäl mot kyrkan: de finns för MÅNGA.
 *
 * `amenity=cafe` träffar varenda mackkiosk, `natural=beach` varje sandstrand längs en
 * hel kust, `leisure=garden` varenda villarabatt någon ritat in. Bara de med NAMN
 * räknas — en plats utan namn går inte att berätta om, och den virtuella resan (enda
 * konsumenten av sorterna) stannar bara vid sådant det finns något att säga om.
 * Namnet är den billigaste kvalitetssignal OSM har.
 */
const NAMNKRÄVANDE: readonly Regel[] = [
  { nyckel: 'amenity', värden: ['cafe'],       sort: 'kafé' },
  // Skarpt fall: CAFÉ BOULE BRÄNNERIET MAGLEHEM är amenity=restaurant + cuisine=pizza.
  // Österlens älskade matställen taggas hur som helst — kafé-filtret ensamt missar dem.
  { nyckel: 'amenity', värden: ['restaurant'], sort: 'krog' },
  { nyckel: 'natural', värden: ['beach'],  sort: 'badplats' },
  { nyckel: 'leisure', värden: ['garden'], sort: 'trädgård' },
  { nyckel: 'shop',    värden: ['farm'],   sort: 'gårdsbutik' },
];

/**
 * Märkvärdig = har en wikipedia- eller wikidata-tagg i OSM.
 *
 * Signalen är gles men träffsäker: den som taggat ett objekt mot Wikipedia har i
 * praktiken intygat att det är en RIKTIG sevärdhet, inte bara en punkt med namn.
 * Skarpt behov (operatörens ord 2026-07-29): "lite tråkiga ställen dyker upp —
 * jag vill ha riktiga sevärdheter." Namn skiljer mackkiosk från kafé; wiki skiljer
 * kafé från kloster.
 */
export function ärMärkvärdig(t: Taggar): boolean {
  return t['wikipedia'] !== undefined || t['wikidata'] !== undefined;
}

/** `null` = ingen sevärdhet. Det normala svaret. */
export function sortAv(t: Taggar): SightKind | null {
  for (const r of REGLER) {
    const v = t[r.nyckel];
    if (v !== undefined && r.värden.includes(v)) return r.sort;
  }
  if (ärSevärdKyrka(t)) return 'kyrka';

  if (namnAv(t).length > 0) {
    for (const r of NAMNKRÄVANDE) {
      const v = t[r.nyckel];
      if (v !== undefined && r.värden.includes(v)) return r.sort;
    }
  }
  return null;
}

/** "Kosta glasbruk". Tom sträng är helt i sin ordning — en namnlös runsten är en runsten. */
export function namnAv(t: Taggar): string {
  return t['name:sv'] ?? t['name'] ?? '';
}
