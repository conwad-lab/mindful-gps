/**
 * GET /api/sight/:id/berattelse   → { text, källor, ljudFinns }
 * GET /api/sight/:id/rost         → audio/mpeg
 *
 * Berättelsen om en sevärdhet, och dess uppläsning. Bådadera på begäran — föraren tryckte
 * på en prick, och det är den enda gången appen säger något om en sevärdhet (se
 * layers.sights.ts och tystnadsdoktrinen).
 *
 * Allt cachas i `sight_story`: komponera en gång, återanvänd för alltid. En sevärdhet i
 * hela Sverige kostar ett par modellanrop TOTALT, inte ett per tryck.
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { SIGHT_WEIGHT, decode6, type LngLat, type Sight, type SightKind } from '@mindful/core';

import { BadRequest } from '../device.js';
import { harÖppenRouterNyckel } from '../ai/openrouter.js';
import { AISaknasError, komponeraBerättelse } from '../sights/berattelse.js';
import type { ORKälla } from '../ai/openrouter.js';
import { RöstSaknasError, talTillLjud } from '../sights/rost.js';

/**
 * De sorter som ritas på översikten och alltså är värda att förhandshämta — samma tröskel
 * som TUNG_NOG i layers.sights.ts. En hembygdsstuga längs vägen är ingen man kör för att
 * se; en utsikt eller en runsten kan vara det.
 */
const TUNGA_SORTER: readonly SightKind[] = (Object.keys(SIGHT_WEIGHT) as SightKind[])
  .filter((k) => SIGHT_WEIGHT[k] >= 0.7);

/** Kör `jobb` över `saker` med högst `bredd` samtidigt. En enkel semafor, ingen dep. */
async function iPar<T>(saker: readonly T[], bredd: number, jobb: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const arbetare = Array.from({ length: Math.min(bredd, saker.length) }, async () => {
    while (i < saker.length) {
      const min = saker[i++];
      if (min !== undefined) await jobb(min);
    }
  });
  await Promise.all(arbetare);
}

interface Rad {
  readonly text: string;
  readonly sources: ORKälla[];
  readonly harLjud: boolean;
}

/** Sevärdheten ur tabellen — allt berättelsen behöver för att komponeras. */
async function hämtaSevärdhet(pool: Pool, id: bigint): Promise<Sight | null> {
  const res = await pool.query<{ kind: string; name: string; lon: number; lat: number }>(
    'SELECT kind, name, ST_X(at) AS lon, ST_Y(at) AS lat FROM sight WHERE id = $1',
    [id.toString()],
  );
  const r = res.rows[0];
  if (!r) return null;
  return { id: Number(id), kind: r.kind as SightKind, name: r.name, at: [r.lon, r.lat] as LngLat };
}

/** Berättelsen ur cachen, eller `null` om den aldrig komponerats. */
async function hämtaBerättelse(pool: Pool, id: bigint): Promise<Rad | null> {
  const res = await pool.query<{ text: string; sources: ORKälla[]; har_ljud: boolean }>(
    'SELECT text, sources, audio IS NOT NULL AS har_ljud FROM sight_story WHERE sight_id = $1',
    [id.toString()],
  );
  const r = res.rows[0];
  return r ? { text: r.text, sources: r.sources, harLjud: r.har_ljud } : null;
}

/** Komponera och cacha. Anropas bara vid en cache-miss. */
async function skapaBerättelse(pool: Pool, sight: Sight): Promise<Rad> {
  const b = await komponeraBerättelse(sight);
  await pool.query(
    `INSERT INTO sight_story (sight_id, text, sources) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (sight_id) DO UPDATE SET text = EXCLUDED.text, sources = EXCLUDED.sources`,
    [sight.id.toString(), b.text, JSON.stringify(b.källor)],
  );
  return { text: b.text, sources: [...b.källor], harLjud: false };
}

/**
 * Resans smak: "värd att STANNA vid?", inte "värd att köra förbi?".
 *
 * Kalibrerad efter operatörens uttalade smak (2026-07-28): vackra vyer, trevliga kaféer
 * och utställningar lockar; runstenar och fornlämningar gör det inte. Runstenen behåller
 * ett nollskilt värde med flit — på en sträcka utan annat är en runsten bättre än
 * tystnad — men tröskeln nedan håller den utanför så länge något annat finns.
 */
const RESA_VIKT: Readonly<Record<SightKind, number>> = {
  utsikt: 1.00,
  vattenfall: 0.95,
  kafé: 0.90,
  vingård: 0.90,
  galleri: 0.85,
  trädgård: 0.85,
  badplats: 0.80,
  gårdsbutik: 0.80,
  museum: 0.80,
  borg: 0.75,
  fyr: 0.75,
  naturreservat: 0.70,
  sevärdhet: 0.55,
  konst: 0.45,
  kyrka: 0.35,
  minnesmärke: 0.15,
  runsten: 0.12,
  fornlämning: 0.10,
};

/** Sorterna resan över huvud taget frågar databasen om. Under 0,30 är det inte smak. */
const RESA_SORTER: readonly SightKind[] = (Object.keys(RESA_VIKT) as SightKind[])
  .filter((k) => RESA_VIKT[k] >= 0.30);

function idAv(raw: unknown): bigint {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new BadRequest('ogiltigt id');
  return BigInt(raw);
}

export function sightStoryRoutes(app: FastifyInstance, opts: { deps: { pool: Pool } }): void {
  const { pool } = opts.deps;

  app.get('/sight/:id/berattelse', async (req) => {
    const id = idAv((req.params as { id?: unknown }).id);

    const cachad = await hämtaBerättelse(pool, id);
    if (cachad) return { text: cachad.text, källor: cachad.sources, ljudFinns: cachad.harLjud };

    const sight = await hämtaSevärdhet(pool, id);
    if (!sight) throw new BadRequest('okänd sevärdhet');

    const skapad = await skapaBerättelse(pool, sight);
    return { text: skapad.text, källor: skapad.sources, ljudFinns: false };
  });

  /**
   * POST /api/sight/prefetch  { polyline, radiusM?, max? }
   *
   * Värm textcachen för sevärdheterna längs en rutt, INNAN körningen. Då finns berättelsen
   * på ett tryck även i täckningsskugga — och det är precis där de vackra små vägarna
   * ligger. Fire-and-forget från klienten: den startar körningen direkt och bryr sig inte
   * om svaret.
   *
   * ⛔ Bara TEXT, aldrig röst. Texten är offline-vinsten; ElevenLabs är dyrt och behöver
   *    ändå nät. Och bara de som SAKNAS — kör man samma rutt igen kostar det ingenting.
   */
  app.post('/sight/prefetch', async (req) => {
    if (!harÖppenRouterNyckel()) return { funna: 0, cachade: 0, komponerade: 0, hoppade: 0 };

    const body = (req.body ?? {}) as { polyline?: unknown; radiusM?: unknown; max?: unknown };
    if (typeof body.polyline !== 'string') throw new BadRequest('polyline saknas');

    const coords = decode6(body.polyline);
    if (coords.length < 2) return { funna: 0, cachade: 0, komponerade: 0, hoppade: 0 };

    // 1200 m: det relevanta avståndet är inte hur långt man SER, utan vad som hamnar på
    // kartan under körningen — och den följer bilen på körzoom (~1 km i bild). Det är de
    // prickarna föraren kan trycka på. Bredare vore att värma upp texter för platser som
    // aldrig kommer i bild; snävare (mätt: 300 m gav noll på Växjö→Kalmar) missar allt.
    const radie = typeof body.radiusM === 'number' ? body.radiusM : 1200;
    const max = typeof body.max === 'number' ? body.max : 12;

    const wkt = `LINESTRING(${coords.map(([lon, lat]) => `${lon} ${lat}`).join(',')})`;

    const res = await pool.query<{
      id: string; kind: string; name: string; lon: number; lat: number; cachad: boolean;
    }>(
      `SELECT s.id, s.kind, s.name, ST_X(s.at) AS lon, ST_Y(s.at) AS lat,
              (st.sight_id IS NOT NULL) AS cachad
         FROM sight s
         LEFT JOIN sight_story st ON st.sight_id = s.id
        WHERE s.kind = ANY($2::text[])
          AND ST_DWithin(
                s.at::geography,
                ST_Simplify(ST_GeomFromText($1, 4326), 0.0008)::geography,
                $3)`,
      [wkt, TUNGA_SORTER as unknown as string[], radie],
    );

    // Tyngst först, sedan taket. Det som ryms är det man helst vill ha berättat.
    const sorterade = res.rows.sort(
      (a, b) => SIGHT_WEIGHT[b.kind as SightKind] - SIGHT_WEIGHT[a.kind as SightKind],
    );
    const valda = sorterade.slice(0, max);
    const hoppade = sorterade.length - valda.length;

    const attKomponera = valda.filter((r) => !r.cachad);
    let komponerade = 0;

    await iPar(attKomponera, 3, async (r) => {
      const sight: Sight = {
        id: Number(r.id), kind: r.kind as SightKind, name: r.name, at: [r.lon, r.lat] as LngLat,
      };
      try {
        await skapaBerättelse(pool, sight);
        komponerade += 1;
      } catch (e) {
        // En miss är ingen kris: trycket under körningen hämtar den live i stället.
        req.log.warn(`prefetch: ${sight.name || sight.kind} gick inte att förbereda (${String(e)})`);
      }
    });

    if (hoppade > 0) {
      req.log.info(`prefetch: ${valda.length} förbereds, ${hoppade} sevärdheter över taket (${max})`);
    }

    return {
      funna: sorterade.length,
      cachade: valda.length - attKomponera.length,
      komponerade,
      hoppade,
    };
  });

  /**
   * POST /api/sight/langs  { polyline, radiusM?, max? }
   *   → { curiosa: [{ id, kind, name, at, alongM }] }  i den ordning man passerar dem
   *
   * Sevärdheterna längs en rutt — men vägda med RESANS smak, inte körningens.
   *
   * `SIGHT_WEIGHT` svarar på "värd att köra förbi?": utsikten toppar för att den syns
   * genom rutan, kaféet ligger i botten för att det kräver att man stannar. Den virtuella
   * resan STANNAR — det är dess natur — så dess fråga är den omvända: "värd att stanna
   * vid?". Därför en egen profil här, i stället för att böja de globala vikterna (som
   * också styr kartans trängselgallring och prefetchens urval under riktiga körningar).
   *
   * Svaret bär `alongM`: sträckan in på rutten där sevärdheten ligger.
   *
   * ⛔ Den virtuella resan är enda anroparen. Under en riktig körning ritas prickarna på
   *    kartan och föraren trycker själv; en lista över vad som kommer härnäst vore
   *    början på en app som tjatar (tystnadsdoktrinen, CONTRACT §6).
   */
  app.post('/sight/langs', async (req) => {
    const body = (req.body ?? {}) as { polyline?: unknown; radiusM?: unknown; max?: unknown };
    if (typeof body.polyline !== 'string') throw new BadRequest('polyline saknas');

    const coords = decode6(body.polyline);
    if (coords.length < 2) return { curiosa: [] };

    const radie = typeof body.radiusM === 'number' ? body.radiusM : 1200;
    // 6, inte 12: en resa med tolv stopp är en busslinje. Sex ger rytm utan att tempot
    // någonsin känns som en kö — och halverar berättelsekostnaden per resa på köpet.
    const max = typeof body.max === 'number' ? body.max : 6;
    const wkt = `LINESTRING(${coords.map(([lon, lat]) => `${lon} ${lat}`).join(',')})`;

    const res = await pool.query<{
      id: string; kind: string; name: string; lon: number; lat: number; along_m: number;
    }>(
      `WITH linje AS (SELECT ST_GeomFromText($1, 4326) AS g)
       SELECT s.id, s.kind, s.name, ST_X(s.at) AS lon, ST_Y(s.at) AS lat,
              ST_LineLocatePoint(linje.g, s.at) * ST_Length(linje.g::geography) AS along_m
         FROM sight s, linje
        WHERE s.kind = ANY($2::text[])
          AND ST_DWithin(
                s.at::geography,
                ST_Simplify(linje.g, 0.0008)::geography,
                $3)`,
      [wkt, RESA_SORTER as unknown as string[], radie],
    );

    // Smakligast först — och namnet väger TUNGT, inte som skiljedomare utan som eget
    // värde. I bilen är en namnlös utsikt fortfarande en utsikt; på en VIRTUELL resa ser
    // man ingen vy, bara berättelsen, och en plats utan namn ger bara "jag hittar inte
    // mycket om just den här platsen". MÄTT före bonusen: 2 av 6 stopp på Lund →
    // Simrishamn var namnlösa utsikter. +0,15 låter ett namngivet kafé (1,05) slå en
    // namnlös utsikt (1,00), medan en namngiven utsikt (1,15) fortfarande toppar allt.
    const NAMN_BONUS = 0.15;
    const rankade = [...res.rows].sort((a, b) => {
      const va = (RESA_VIKT[a.kind as SightKind] ?? 0) + (a.name ? NAMN_BONUS : 0);
      const vb = (RESA_VIKT[b.kind as SightKind] ?? 0) + (b.name ? NAMN_BONUS : 0);
      return vb - va;
    });

    // Sedan glest, inte tätt. MÄTT på Lund → Simrishamn: utan spärren låg 9 av 12
    // curiosa inom de första 4,4 km — fyra namnlösa runstenar inom 200 m av varandra —
    // och sedan tystnad i fem mil. En resa ska andas jämnt; ett stopp var annan
    // kilometer är den glesaste täthet som fortfarande känns som en resa och inte som
    // en lista.
    const MELLANRUM_M = 2000;
    const valda: typeof rankade = [];
    for (const r of rankade) {
      if (valda.length >= max) break;
      if (valda.some((v) => Math.abs(v.along_m - r.along_m) < MELLANRUM_M)) continue;
      valda.push(r);
    }

    // Tillbaka till VÄGENS ordning: en resa passerar dem i den ordning de ligger, inte
    // i intresseordning.
    valda.sort((a, b) => a.along_m - b.along_m);

    return {
      curiosa: valda.map((r) => ({
        id: Number(r.id),
        kind: r.kind as SightKind,
        name: r.name,
        at: [r.lon, r.lat] as LngLat,
        alongM: r.along_m,
      })),
    };
  });

  app.get('/sight/:id/rost', async (req, reply) => {
    const id = idAv((req.params as { id?: unknown }).id);

    // Har vi redan ljudet? Skicka det direkt.
    const befintligt = await pool.query<{ audio: Buffer | null }>(
      'SELECT audio FROM sight_story WHERE sight_id = $1', [id.toString()],
    );
    const cachatLjud = befintligt.rows[0]?.audio;
    if (cachatLjud) {
      void reply.header('content-type', 'audio/mpeg');
      void reply.header('cache-control', 'public, max-age=604800');
      return reply.send(cachatLjud);
    }

    // Ingen text än? Komponera den först — man kan trycka "läs upp" innan texten cachats.
    let text: string;
    const rad = await hämtaBerättelse(pool, id);
    if (rad) {
      text = rad.text;
    } else {
      const sight = await hämtaSevärdhet(pool, id);
      if (!sight) throw new BadRequest('okänd sevärdhet');
      text = (await skapaBerättelse(pool, sight)).text;
    }

    const ljud = await talTillLjud(text);
    await pool.query('UPDATE sight_story SET audio = $2 WHERE sight_id = $1',
      [id.toString(), ljud]);

    void reply.header('content-type', 'audio/mpeg');
    void reply.header('cache-control', 'public, max-age=604800');
    return reply.send(ljud);
  });
}

export { AISaknasError, RöstSaknasError };
