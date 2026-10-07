# EXIT SEO Crawler

Interne SEO-crawler van Dutch Toys Group, in de EXIT-huisstijl. Een desktop-app (macOS en Windows) in de stijl van Screaming Frog: hij crawlt een site en toont statuscodes, titels, meta's, canonicals, hreflang, structured data en ruim 170 SEO-checks.

Gebaseerd op [FreeCrawl SEO Tool](https://github.com/kemalai/FreeCrawl-SEO-Tool) van kemalai (MIT-licentie, zie [LICENSE](LICENSE)). De volledige functiebeschrijving staat in [docs/FREECRAWL-README.md](docs/FREECRAWL-README.md).

## Installeren

Download de installer van [dashboard-exit.com/crawler](https://dashboard-exit.com/crawler) (zonder inlog) of van de [Releases-pagina](https://github.com/Dutchtoysgroup/exit-seo-crawler/releases) (met toegang tot de Dutchtoysgroup-organisatie op GitHub).

| Systeem | Bestand |
|---|---|
| Mac met Apple-chip (M1 en nieuwer) | `EXIT-SEO-Crawler-<versie>-macOS-Apple-Silicon.dmg` |
| Mac met Intel-chip | `EXIT-SEO-Crawler-<versie>-macOS-Intel.dmg` |
| Windows | `EXIT-SEO-Crawler-<versie>-Windows-Setup.exe` (of `-Portable.exe` zonder installatie) |

De Mac-versie is vanaf 1.0.2 ondertekend en door Apple genotariseerd: hij opent zonder waarschuwing, ook de CLI. De Windows-versie is nog niet ondertekend:

- **Windows**: SmartScreen toont "Windows heeft uw pc beschermd". Klik op **Meer informatie** → **Toch uitvoeren**.

Updates: Help → Controleren op updates opent de Releases-pagina. De app zoekt niet zelf naar updates, omdat de repo privé is.

## CLI

Naast de app is er een commandoregelprogramma, `exit-seo-crawler`: één bestand per platform, zonder Node-installatie. Het kan alles behalve JavaScript-rendering (dat zit alleen in de app).

Installeren op een Mac:

```bash
curl -fsSL https://dashboard-exit.com/crawler/install.sh | sh
```

Op Windows, in PowerShell:

```powershell
irm https://dashboard-exit.com/crawler/install.ps1 | iex
```

Daarna bijvoorbeeld `exit-seo-crawler https://www.exittoys.nl --max 500 --out crawl.csv`. Alle opties: `exit-seo-crawler --help`. Losse downloads staan ook op [dashboard-exit.com/crawler](https://dashboard-exit.com/crawler). De release-workflow bouwt de CLI met `apps/cli/scripts/build-sea.mjs` (Node single executable application).

## Wat er anders is dan FreeCrawl

1. **Geen DNS-fallback naar vaste IP-adressen.** FreeCrawl viel bij een mislukte DNS-lookup terug op 1.1.1.1, 1.0.0.1, 8.8.8.8 en 9.9.9.9 (UDP/53 en DNS-over-HTTPS). Die directe verbindingen leverden firewall- en sandboxprompts op waarin je eerst IP-adressen moest goedkeuren. Deze versie gebruikt alleen de DNS van het besturingssysteem (`packages/core/src/dns-resolver.ts`).
2. **Geen blokkade op interne adressen.** FreeCrawl sloeg externe links en afbeeldingen op `localhost`, `*.local`, 10.x, 172.16–31.x, 192.168.x en 169.254.x over zodra de start-URL publiek was. Deze versie controleert ze gewoon. Gevolg: linkt een gecrawlde pagina naar een adres in je eigen netwerk, dan stuurt de crawler daar een verzoek naartoe. Crawl dus alleen sites die je vertrouwt.
3. **EXIT-huisstijl.** Logo, app-icoon, Inter als font en het kleurpalet van het marketing dashboard (licht thema is standaard). Bronbestanden en uitleg: [apps/desktop/resources/brand](apps/desktop/resources/brand/README.md).
4. **Naam en updates.** "FreeCrawl" heet in de hele app (11 talen) "EXIT SEO Crawler". De update-check van upstream is vervangen door een link naar de Releases-pagina hierboven. Het Over-venster vermeldt FreeCrawl als basis.

Bewust níét veranderd: de standaard User-Agent (`FreeCrawlSEO/0.1`). Daardoor ziet een site die je crawlt (ook van een concurrent) niet dat de crawler van EXIT komt. Je kunt hem per crawl aanpassen in Instellingen.

## Ondertekening (macOS)

De release-workflow ondertekent de Mac-app en de CLI met **Developer ID Application: Sven Dijk (VAM683M962)** (persoonlijk Apple Developer-account van Sven, geldig tot 17 september 2031) en laat ze notariseren via de App Store Connect API. Repo-secrets:

| Secret | Inhoud |
|---|---|
| `CSC_LINK` | het certificaat met privésleutel als `.p12`, base64 |
| `CSC_KEY_PASSWORD` | wachtwoord van die `.p12` |
| `APPLE_API_KEY_P8` | inhoud van `AuthKey_<id>.p8` (staat ook in 1Password; Apple geeft hem maar één keer) |
| `APPLE_API_KEY_ID` | Key ID van die sleutel |
| `APPLE_API_ISSUER` | Issuer ID uit App Store Connect |

De workflow zet het certificaat alleen op de Mac-runners in een tijdelijke sleutelhanger. Gaat Dutch Toys Group later een eigen Apple-account gebruiken, dan werken Mac-updates niet automatisch over teams heen: iedereen installeert dan één keer handmatig.

## Ontwikkelen

Node 22 of nieuwer.

```bash
npm ci
```

```bash
npx tsc -b
```

```bash
npm run dev
```

`npm ci` haalt via `postinstall` ook Chromium voor Playwright op (voor JavaScript-rendering, zo'n 250 MB). Sla dat over met `npm ci --ignore-scripts`; Electron moet je dan zelf installeren met `node node_modules/electron/install.js`.

Een installer lokaal bouwen (alleen voor je eigen platform):

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm --workspace apps/desktop run build:mac -- --arm64
```

## Release maken

1. Verhoog de versie in `package.json` en `apps/desktop/package.json`.
2. Commit, tag en push:
   ```bash
   git tag v1.0.1 && git push origin main v1.0.1
   ```
3. De workflow [Release](.github/workflows/release.yml) bouwt de macOS-installers (Apple Silicon en Intel) en de Windows-installers en zet ze op de Releases-pagina, met Chromium meegebundeld. Dat duurt ongeveer 20 minuten.

## Updates van FreeCrawl binnenhalen

```bash
git remote add --no-tags upstream https://github.com/kemalai/FreeCrawl-SEO-Tool.git
```

```bash
git fetch upstream && git merge upstream/main
```

`--no-tags` houdt de versie-tags van FreeCrawl buiten deze repo: die heeft een eigen versielijn (1.0.0 = gebaseerd op FreeCrawl 1.0.0).

Conflicten verwacht je vooral in de locale-bestanden (de naam), `styles.css`, `dns-resolver.ts`, `crawler.ts` en `apps/desktop/src/main/index.ts` (update-check). Draai na een merge nog eens een zoekopdracht op `FreeCrawl` in `apps/` en `packages/`: nieuwe teksten van upstream noemen de app nog bij de oude naam.
