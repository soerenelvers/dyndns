# DynDNS

Eigener DynDNS-Dienst für Ubuntu 24.04 LTS und Node.js 24 LTS. DNS-Einträge werden über Contabo gepflegt; Benutzer melden sich über ZugangsWerk an. Die Anwendung läuft als einzelner Node-Prozess hinter einem HTTPS-Reverse-Proxy.

## Funktionen

- Persönliche Hostnamen unter einer festgelegten DynDNS-Unterdomain.
- A- und AAAA-Updates über den DynDNS-Endpunkt `/nic/update`.
- Kryptografisch zufälliger, austauschbarer Update-Token pro Hostname; gespeichert wird nur sein SHA-256-Hash.
- OIDC Authorization Code mit PKCE, serverseitigen Sessions und aktueller Rechteprüfung gegen ZugangsWerk.
- SQLite für Hostnamen, DNS-Zuordnungen und Sessions; kein zusätzlicher Datenbankdienst.
- Lokaler Testbetrieb ohne Zugangsdaten und ohne öffentliche DNS-Änderungen.

## Lokal entwickeln

Node.js **24 LTS** und npm verwenden:

```sh
npm ci --ignore-scripts --no-fund --no-audit
node scripts/setup-dev.js
npm test
npm run dev
```

Im eigenen lokalen Browser ist die Anwendung unter `http://localhost:3000` erreichbar. In einer Codex-Cloud-Aufgabe über lokale HTTP-Anfragen prüfen; dort gibt es keine Webvorschau. `setup-dev.js` erstellt einmalig eine ignorierte `.env` mit zufälligem Session-Schlüssel. Bestehende Dateien werden nicht überschrieben. Das Testkonto und der Mock-Anbieter sind in Produktion gesperrt.

```sh
npm run check   # JavaScript-Syntax
npm test        # HTTP-, DNS- und OIDC-Integrationstests mit lokalen Fixtures
npm start      # ohne Dateiwächter
```

Ein Build-Schritt entfällt. Das Projekt verwendet JavaScript-ES-Module und Node-eigene SQLite- sowie Test-Unterstützung. SQLite kann eine Experimental-Warnung von Node ausgeben.

## Auf dem Server betreiben

[Servereinrichtung und Git-Updates](docs/deployment.md) beschreiben Ubuntu, systemd, HTTPS, Contabo, ZugangsWerk und Datensicherung. [Architektur und Sicherheitsregeln](docs/architecture.md) erklären Zugriffe und Grenzen. [Router anbinden](docs/clients.md) enthält Update-Format und Fehlercodes.

Für den ersten Live-Betrieb werden eine Anwendungsdomain, eine Contabo-DNS-Zone, Contabo-API-Zugangsdaten und ein in ZugangsWerk freigeschalteter Client benötigt. Zugangsdaten ausschließlich auf dem Server beziehungsweise in sicheren Umgebungsvariablen hinterlegen.

## Umfang dieser Version

Ein Serverprozess, eine DNS-Zone, eine DynDNS-Unterdomain. Benutzer können ihre eigenen Hostnamen anlegen, Tokens ersetzen und Updates pausieren. Hostnamen bleiben reserviert, DNS-Einträge werden nicht automatisch gelöscht. Keine Domainregistrierung, kein eigener autoritativer DNS-Server und keine zentrale Benutzerverwaltung. Entwicklungstests ersetzen keinen Live-Abnahmetest mit dem eigenen Router und DNS-Konto.
