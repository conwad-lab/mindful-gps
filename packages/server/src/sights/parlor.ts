/**
 * Pärlspanaren — hittar de älskade ställena som ingen tagg kan peka ut.
 *
 * ── Problemet den löser ─────────────────────────────────────────────────────
 *
 * Det som gör Café Boule i Maglehem älskat — atmosfären, boulebanorna, ryktet — finns
 * inte i någon OSM-tagg. Wiki-taggen fångar slott och raviner; namn-kravet silar bort
 * mackkiosker; men en bykrog och en kultkrog ser identiska ut i datan. Och på en väg
 * man aldrig kört (operatörens skarpa fall: Cambrils → Altafulla) finns ingen
 * favoritlista att luta sig mot — man kan inte lista ställen man aldrig varit på.
 *
 * Rykte bor på webben. Alltså frågar vi webben: ruttens oprövade kandidater (kaféer,
 * krogar, gårdsbutiker …) skickas till sökmodellen — samma grundade `:online`-väg som
 * berättelserna — med frågan "vilka av dessa är omtyckta eller speciella?". De
 * utpekade blir pärlor och rankas som wiki-platser.
 *
 * ── Kostnadsdisciplin ───────────────────────────────────────────────────────
 *
 * Domen CACHAS per plats i `sight.parla` (NULL = aldrig prövad). Första resan över en
 * sträcka betalar ETT sökanrop för högst PRÖVAS_MAX kandidater; varje resa därefter
 * läser cachen gratis. En dom är inte färskvara — ett ställe som var älskat i fjol är
 * det oftast i år, och en omprövning är bara en `UPDATE sight SET parla = NULL` bort.
 *
 * ⛔ Pärlspanaren får ALDRIG blockera en resa: varje slags miss — ingen nyckel, timeout,
 *    oparsbart svar — ger tom pärlmängd, och urvalet faller tillbaka på tagg-signalerna.
 */

import type { Pool } from 'pg';

import { harÖppenRouterNyckel, openrouterChat } from '../ai/openrouter.js';

/** Sorterna vars värde bärs av rykte snarare än av kategorin själv. */
const RYKTES_SORTER = new Set(['kafé', 'krog', 'gårdsbutik', 'galleri', 'vingård']);

/** Fler kandidater än så per anrop blir en gissningslek för modellen, inte en spaning. */
const PRÖVAS_MAX = 25;

/** Högst så många pärlor per anrop. Är allt en pärla är inget det. */
const PÄRLOR_MAX = 6;

const SYSTEM = [
  'Du är en lokalkännare som skiljer älskade ställen från vanliga.',
  'Du får en lista med matställen och butiker längs en bilväg. Sök på webben efter dem.',
  'Peka ut de som är SÄRSKILT omtyckta, omskrivna eller speciella — ställen folk kör',
  'omvägar för: kultkaféer, legendariska krogar, gårdsbutiker med rykte.',
  '',
  'Regler:',
  `- Svara ENDAST med en JSON-array av exakta namn ur listan. Högst ${PÄRLOR_MAX}.`,
  '- Ta bara med ställen du faktiskt hittar beröm om. Hittar du inget: svara [].',
  '- Ett vanligt fungerande ställe är INTE en pärla. Hellre tom lista än artighet.',
].join('\n');

export interface PärlKandidat {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly lon: number;
  readonly lat: number;
  /** Cachad dom, eller null om platsen aldrig prövats. */
  readonly parla: boolean | null;
}

/** Namnen ur modellens svar — tolerant mot ```json-staket och prosa runt omkring. */
function tolkaNamn(svar: string): string[] {
  const rensat = svar.replace(/```(?:json)?/g, '').trim();
  const start = rensat.indexOf('[');
  const slut = rensat.lastIndexOf(']');
  if (start === -1 || slut <= start) return [];
  try {
    const parsed = JSON.parse(rensat.slice(start, slut + 1)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is string => typeof n === 'string');
  } catch {
    return [];
  }
}

/**
 * Pärlorna bland kandidaterna: cachade domar + EN spaning för de oprövade.
 *
 * Returnerar id:na för alla kandidater som är pärlor. Skriver domarna (både ja och
 * nej) till `sight.parla` så nästa resa läser gratis.
 */
export async function hittaPärlor(
  pool: Pool,
  kandidater: readonly PärlKandidat[],
): Promise<Set<string>> {
  const pärlor = new Set<string>(
    kandidater.filter((k) => k.parla === true).map((k) => k.id),
  );

  if (!harÖppenRouterNyckel()) return pärlor;

  const oprövade = kandidater
    .filter((k) => k.parla === null && RYKTES_SORTER.has(k.kind) && k.name)
    .slice(0, PRÖVAS_MAX);
  if (oprövade.length === 0) return pärlor;

  try {
    const lista = oprövade
      .map((k) => `- ${k.name} (${k.kind}, nära ${k.lat.toFixed(3)}, ${k.lon.toFixed(3)})`)
      .join('\n');

    const svar = await openrouterChat({
      model: process.env['OPENROUTER_STORY_MODEL'] ?? 'perplexity/sonar-pro-search',
      temperature: 0.2,
      maxTokens: 300,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Ställen längs vägen:\n${lista}` },
      ],
    });

    const utpekade = new Set(tolkaNamn(svar.content).map((n) => n.trim().toLowerCase()));

    const ja: string[] = [];
    const nej: string[] = [];
    for (const k of oprövade) {
      if (utpekade.has(k.name.trim().toLowerCase())) { ja.push(k.id); pärlor.add(k.id); }
      else nej.push(k.id);
    }

    // Båda domarna cachas — även "ingen pärla" är ett svar värt att slippa köpa igen.
    if (ja.length > 0) {
      await pool.query('UPDATE sight SET parla = true WHERE id = ANY($1::bigint[])', [ja]);
    }
    if (nej.length > 0) {
      await pool.query('UPDATE sight SET parla = false WHERE id = ANY($1::bigint[])', [nej]);
    }
  } catch {
    // Spaningen är en bonus, aldrig ett krav. Resan går med tagg-signalerna.
  }

  return pärlor;
}
