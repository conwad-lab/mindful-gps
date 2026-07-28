# Lokal setup (rekonstruerad provisionering)

> Upstream-README:n antar en Valhalla-container och en PostGIS-databas som redan
> finns ("docker start mindful-valhalla"). Det här dokumentet är de saknade
> stegen, rekonstruerade ur kodkommentarerna och `spike/vakta-valhalla.sh`.
> Uppsatt 2026-07-28 på Apple Silicon med colima som container-runtime.

## Förutsättningar

```bash
brew install colima docker osmium-tool
colima start --cpu 4 --memory 8 --disk 60 --dns 1.1.1.1 --dns 8.8.8.8
```

Node 22+ krävs (`process.loadEnvFile` i `packages/server/src/env.ts`).

Två fallgropar vi träffade vid uppsättningen:
- **DNS i VM:en**: utan `--dns`-flaggorna fick colima:s interna resolver
  (192.168.5.1) timeout på alla registry-uppslag.
- **Gammal Docker Desktop-rest**: om `~/.docker/config.json` innehåller
  `"credsStore": "desktop"` failar varje pull med
  `docker-credential-desktop: executable file not found` — ta bort nyckeln.

## 1. Beroenden + miljö

```bash
npm install
cp .env.example .env
```

I `.env`:
- `OPENROUTER_API_KEY` — krävs för sevärdhets-berättelserna (annars artig 501).
- `OPENROUTER_STORY_MODEL=perplexity/sonar-pro-search` — behåll förvalet.
  A/B-testat 2026-07-28 på Linné-statyn i Lund: `claude-haiku-4.5:online`
  (det "billigare alternativet" i `.env.example`) fabulerade självsäkert om
  Linnés Hammarby i Uppsala trots koordinater i prompten; sonar svarade ärligt
  "Jag hittar inte mycket om just den här platsen" och grundade motprovet
  (Dalby heligkorskyrka) korrekt. Ärligheten är värd merkostnaden.
  Obs vid modellbyte-test: berättelser cachas i `sight_story` — rensa raden
  (`DELETE FROM sight_story WHERE sight_id = …`) annars serveras gammal text.
- `ELEVENLABS_API_KEY` — **valfri, och kräver betald plan**. Tom = uppläsnings-
  knappen svarar ärligt "Uppläsning är inte påslagen" (501).

  ⚠️ Testat 2026-07-28: **ElevenLabs Free-plan har ingen API-åtkomst.** Varje
  röst ger `402 paid_plan_required` ("Free users cannot use library voices via
  the API"), och ett tomt "Mina Röster" hjälper inte — det är planen som
  blockerar, inte röstvalet. Minst Starter (~$6/mån) krävs.

  ⚠️ Upstreams förvalda `ELEVENLABS_VOICE_ID=Mml2TPQDyjmb9MxQdllJ` är
  upphovsmannens egen röst och ger `404 voice_not_found` på andra konton.
  Byt till en röst ur ditt eget konto när planen är uppgraderad.

  Håll nyckeln TOM tills kontot är på Starter+ — med en nyckel satt kastar
  `/rost` 500 "internt fel" i stället för det ärliga 501:et.

  **Gratis röst finns redan inbyggd** — se nedan. Ingen nyckel behövs för att
  höra berättelserna.

## Gratis uppläsning: webbläsarens talsyntes

Fork-tillägg (`packages/web/src/ui/talSyntes.ts`). Svarar servern 501 —
uppläsning inte påslagen — läses berättelsen i stället upp av webbläsarens
egen röst (Alva på macOS/iOS för svenska). Kostar ingenting.

Rollfördelningen följer CONTRACT §6: ElevenLabs är primär när nyckeln är satt,
talsyntesen är **fallback**, och fallback-vägen är komplett i sig själv. Under
knappen står "Webbläsarens röst." när det är robotrösten som ljuder — appen
låtsas aldrig att den är den goda rösten.

Tre detaljer specen kräver, och som implementationen därför har:
- **Watchdog** — kommer inte `onend` inom estimerad tid × 2 avbryts motorn.
  Talsyntesen hänger sig på iOS om appen bakgrundas mitt i en mening.
- **`getVoices()` ljuger** — röstlistan är tom i Chrome tills `voiceschanged`
  kommit. Cachen värms vid import så att uppläsningen kan startas SYNKRONT i
  knapptrycket; iOS kräver en användargest, och ett `await` bryter den.
- **`sv-SE`-whitelist** med normalisering av `sv_SE` → `sv-SE`.

Servern frågas bara en gång per session: efter ett 501-svar går knappen direkt
på webbläsarrösten (`serverRöstenÄrAv()` i `sevardhetBerattelse.ts`).

Texten talas mening för mening som köade utterances — Chrome tystnar mitt i
utterances längre än ~15 s, och en tvåmeningarsberättelse ligger över det.

## 2. OSM-data (engångs, ~784 MB)

```bash
mkdir -p valhalla/custom_files valhalla/vagindex && cd valhalla/custom_files
curl -LO https://download.geofabrik.de/europe/sweden-latest.osm.pbf

# Vägindexets källa (132 MB) — filter från packages/server/src/roadindex/osmium.ts
osmium tags-filter sweden-latest.osm.pbf \
  w/highway=primary,secondary,tertiary,unclassified,residential,living_street,track \
  -o ../vagindex/smavagar.osm.pbf

# Sevärdheternas källa (~9 MB) — filter från packages/server/src/sights/osmium.ts
osmium tags-filter sweden-latest.osm.pbf \
  nwr/historic nwr/tourism=viewpoint,attraction,museum,artwork \
  nwr/natural=waterfall nwr/leisure=nature_reserve nwr/man_made=lighthouse \
  nwr/amenity=place_of_worship \
  -o ../vagindex/sevardheter.osm.pbf
cd ../..
```

**Varför `vagindex/` och inte `custom_files/`** (avviker från kodens defaults):
Valhalla-byggcontainern bygger tiles av *alla* `.pbf`-filer den hittar i
`/custom_files` — låg de filtrerade filerna kvar där skulle vägnätet byggas in
dubbelt. Därför ligger de i en egen katalog och pekas ut i `.env` med kodens
env-overrides (absoluta sökvägar — de resolvas mot cwd, inte repo-roten):

```
ROADS_PBF=/abs/väg/till/valhalla/vagindex/smavagar.osm.pbf
SIGHTS_PBF=/abs/väg/till/valhalla/vagindex/sevardheter.osm.pbf
```

## 3. PostGIS (port 5435, creds mindful/mindful/mindful)

```bash
docker run -d --name mindful-pg --restart unless-stopped -p 5435:5432 \
  -e POSTGRES_USER=mindful -e POSTGRES_PASSWORD=mindful -e POSTGRES_DB=mindful \
  -v mindful-pgdata:/var/lib/postgresql/data postgis/postgis:16-3.4
```

Schemat skapas av serverns `migrate()` vid varje start (idempotent) — ingen
separat migrering.

Obs: `postgis/postgis:16-3.4` finns bara som amd64 — den kör via emulering på
Apple Silicon. Fullt funktionellt och snabbt nog för den här databasen.

## 4. Valhalla: bygg tiles, starta ruttservern

Bygg (engångs; Sverige tar en stund):

```bash
docker run --name mindful-valhalla-build \
  -v "$PWD/valhalla/custom_files:/custom_files" \
  -e tile_urls= -e serve_tiles=False -e force_rebuild=True \
  -e build_elevation=False -e build_admins=False -e build_time_zones=False \
  ghcr.io/gis-ops/docker-valhalla/valhalla:latest
```

Servera (flaggorna ur `spike/vakta-valhalla.sh`):

```bash
docker rm -f mindful-valhalla 2>/dev/null
docker run -d --name mindful-valhalla --restart unless-stopped -p 8002:8002 \
  -v "$PWD/valhalla/custom_files:/custom_files" \
  -e serve_tiles=True -e use_tiles_ignore_pbf=True -e force_rebuild=False \
  -e build_elevation=False -e build_admins=False -e build_time_zones=False \
  -e server_threads=8 \
  ghcr.io/gis-ops/docker-valhalla/valhalla:latest
```

Servern verifierar själv vid start att motorn stödjer `through`-waypoints och
`search_filter.max_road_class` — misslyckas proben är tiles/imagen fel.

## 5. Schema + seed

```bash
# Schemat: antingen en första serverstart (migrate() kör vid boot, kräver att
# Valhalla redan svarar) — eller direkt, utan Valhalla:
docker exec -i mindful-pg psql -U mindful -d mindful -v ON_ERROR_STOP=1 \
  < packages/server/src/db/schema.sql

# Seeden läser INTE .env (env-laddaren importeras bara av serverns index.ts),
# så pbf-overriderna måste sättas i kommandot:
ROADS_PBF="$PWD/valhalla/vagindex/smavagar.osm.pbf" \
SIGHTS_PBF="$PWD/valhalla/vagindex/sevardheter.osm.pbf" \
npx tsx packages/server/src/roadindex/seed.ts 13.19 55.70 140   # Lund, 140 km
```

Ordningen spelar roll: `seed.ts` kräver att tabellerna finns. Obs: extrakten
är sweden-latest — danska sidan av Öresund ingår inte.

## 6. Kör

```bash
npm run dev   # web 5202 · server 8161 · Valhalla 8002 · Postgres 5435
```

Virtuell resa utan bil: `http://localhost:5202/?sim=1&start=13.191,55.704&takt=40`

## Virtuell resa (curiosa-tempo)

Fork-tillägg (`packages/web/src/resa/`). Res sträckan hemifrån: landskapet drar
förbi på kartan, och vid varje sevärdhet **stannar** resan, berättar och
fortsätter sedan.

```
http://localhost:5202/?sim=1&resa=1&curiosa=45&start=13.191,55.704
```

`curiosa=N` är **sekunder mellan curiosa** — inte km/h. Tempot styr hur ofta det
händer något; appen räknar själv ut hur mycket väggklockan ska komprimeras för
att sträckan fram till nästa sevärdhet ska ta ungefär den tiden. En mil ödemark
går fort, tätt mellan runstenarna går långsamt. Reglaget ändrar tempot mitt i
resan och visar `3 av 11`.

Planera som vanligt ("Vart?" → Kör mig dit → Kör) — resan tar över därifrån.

**Doktringräns.** Appen berättar annars aldrig oombett (CONTRACT §6): ett blad
som slår upp sig självt i 90 km/h är en olycka. Autoläsningen kan därför bara
tändas av resläget, och resläget kräver `?sim=1` — en riktig körning kan inte nå
det, oavsett URL.

Urvalet (`POST /api/sight/langs`) är tyngst-först med **minst 2 km mellan
curiosa**. Mätt på Lund → Simrishamn utan spärren: 9 av 12 låg inom de första
4,4 km — fyra namnlösa runstenar inom 200 m — och sedan tystnad i fem mil. Med
spärren: 12 jämnt fördelade över 10 mil, 10 av 12 med namn.

Kräver OpenRouter-krediter: utan berättelse hoppar resan vidare direkt (den
stannar aldrig vid en sten den inte kan berätta om).

## Kända avvikelser mot upstream-dokumentationen

- `npm run bench` är trasigt i upstream (`bench/run.ts` finns inte).
- `VALHALLA_API_KEY` i `.env.example` läses aldrig av koden.
