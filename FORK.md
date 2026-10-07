# Dutch Toys Group fork

Fork van [kemalai/FreeCrawl-SEO-Tool](https://github.com/kemalai/FreeCrawl-SEO-Tool) (MIT). Twee dingen wijken af van upstream:

1. **Geen DNS-fallback naar vaste IP-adressen.** Upstream viel bij een mislukte DNS-lookup terug op publieke DNS-servers (UDP/53 naar 1.1.1.1, 1.0.0.1, 8.8.8.8 en 9.9.9.9) en daarna op DNS-over-HTTPS naar dezelfde IP's. Die directe verbindingen leverden firewall- en sandboxprompts op waarin je eerst IP-adressen moest goedkeuren. Deze fork resolvet alleen via de DNS van het besturingssysteem (`packages/core/src/dns-resolver.ts`).
2. **Geen SSRF-guard op privé-adressen.** Upstream sloeg externe links en afbeeldingen op `localhost`, `*.local`, 10.x, 172.16–31.x, 192.168.x en 169.254.x over ("Skipped: private/internal address (SSRF guard)") zodra de start-URL publiek was. Deze fork controleert ze gewoon (`packages/core/src/crawler.ts`).

Gevolg: de crawler doet nu ook verzoeken naar interne adressen als een gecrawlde pagina daarnaar linkt. Crawl dus alleen sites die je vertrouwt.

## Upstream bijwerken

```bash
git remote add upstream https://github.com/kemalai/FreeCrawl-SEO-Tool.git  # eenmalig
git fetch upstream
git merge upstream/main
```

Conflicten verwacht je alleen in de vier bestanden hierboven en in `packages/core/src/http-client.ts` (foutmeldingen).
