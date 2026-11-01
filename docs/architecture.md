# Architektur und Entwicklungsregeln

## Aufbau

Browser → HTTPS-Webserver → Express → SQLite / ZugangsWerk / Contabo.

- `src/config.js`: validierte Umgebungsvariablen, sichere Produktionsgrenzen.
- `src/auth.js`: OIDC mit openid-client, PKCE, Nonce, State, Sessionwechsel, Token-Erneuerung, Live-Rechteprüfung.
- `src/app.js`: serverseitige HTML-Seiten, Formular-CSRF-Schutz, Eigentümerprüfung und DynDNS-Endpunkt.
- `src/updates.js`: öffentliche IPs, Token-Hashes, Serialisierung und Abgleich mit DNS.
- `src/dns.js`: Contabo-API-Adapter und persistenter lokaler Testanbieter.
- `src/db.js`: SQLite-Schema und serverseitiger Session-Store.
- `test/`: HTTP-Abläufe, signierte OIDC-Fixtures, Rollenentzug, Refresh-Rennen und Contabo-Vertragsprüfungen.

Die erste Version hat keine Hintergrundprozesse, keine SPA und keinen Build-Schritt. Der Serverprozess muss nach Codeänderungen neu starten. Initialisierung legt fehlende Tabellen wiederholbar an; spätere Schemaänderungen benötigen versionierte Migrationen mit Rückwärtskompatibilität und Backup-Anleitung.

## Identitäten und Rechte

Benutzer werden über das Paar `iss` und `sub` identifiziert, nicht über E-Mail oder Anzeigenamen. Jede Verwaltungsanfrage benötigt die aktuelle ZugangsWerk-Freigabe. Lesen verlangt `dyndns.read`, Anlegen, Tokenwechsel und Pausieren verlangen `dyndns.write`. Benutzer sehen und ändern ausschließlich ihre eigenen Hostnamen.

Der Router verwendet einen separaten, auf einen Hostnamen beschränkten 256-Bit-Token. Sein Hash liegt in SQLite, der Klartext wird einmal angezeigt. Gerätezugänge laufen unabhängig von kurzlebigen Benutzersitzungen: **Der Entzug eines ZugangsWerk-Benutzerzugangs sperrt bestehende Router-Tokens nicht automatisch.** Bei Ausscheiden eines Benutzers muss der Betreiber zusätzlich dessen Hosts in der lokalen Datenbank pausieren. Beispiel als Dienstbetreiber bei gestopptem Dienst mit SQLite-Werkzeug und geprüfter Eigentümer-ID: `UPDATE hosts SET enabled = 0 WHERE owner = ?`. In dieser Version gibt es noch keine globale Administratoroberfläche und keinen automatischen zentralen Sperrabgleich. Für eine öffentliche Mehrbenutzerfreigabe muss dieser Verwaltungsprozess weiterentwickelt werden.

Anmeldung und aktuelle Rechteprüfung sind getrennt. Ein Token für einen anderen Client wird von ZugangsWerk abgewiesen; zusätzlich müssen `sub` und `clientId` der Antwort zur lokalen Sitzung passen. Refresh-Anfragen werden je Sitzung serialisiert und neu gespeicherte Refresh-Tokens vor der nächsten Anfrage erneut geladen.

## DNS-Verhalten

Der Betreiber legt die Zone und eine echte Unterdomain fest. Benutzer wählen nur ein einzelnes Label darunter. DNS-IDs werden nach erfolgreicher Erstellung je Host und IP-Familie gespeichert. Vor jeder Änderung wird die Zone paginiert gelesen. Nur ein Eintrag mit passendem Namen, Typ und gespeicherter Anbieter-ID wird geändert; fremde bestehende Einträge und CNAME-Konflikte blockieren den Vorgang. TTL- und IP-Abweichungen werden korrigiert.

Die Contabo-API erwartet relative Namen bei der Erstellung, `prio: 0`, Bearer-Authentifizierung und `x-request-id`. A-/AAAA-Änderungen erfolgen mit PATCH. Authentifizierung nutzt das API-Konto aus dem Kundenbereich. Referenz: [offizielles Contabo-cntb-OpenAPI](https://github.com/contabo/cntb/blob/f45f76e574f3cfdae50d52a3e646f9563ec90030/openapi/api/openapi.yaml).

Ein Prozess serialisiert alle Host- und DNS-Mutationen, damit parallele Erstupdates keine doppelten Records erzeugen und Tokenwechsel in definierter Reihenfolge erfolgen. Schreibvorgänge werden bei unklarer Antwort nicht blind wiederholt. Dual-Stack-Updates sind beim Anbieter nicht atomar. Hostnamen und DNS-Einträge werden beim Pausieren nicht gelöscht.

## Schutzgrenzen

- Produktion verlangt HTTPS, echte DNS-Konfiguration und deaktivierten Entwicklungszugang.
- Node bindet standardmäßig an Loopback; nur Loopback-Proxys dürfen Forwarding-Header setzen. Dies ist ein Vertrauensverhältnis zum eigenen Server, keine Absicherung gegen lokale privilegierte Prozesse.
- HTML-Ausgaben sind maskiert, Formulare verlangen ein CSRF-Token und prüfen vorhandene Origin-Header.
- Cookies sind HttpOnly, SameSite=Lax und in Produktion Secure. Sitzungen laufen nach acht Stunden ab und werden serverseitig gespeichert. Access-/Refresh-Tokens liegen innerhalb dieser geschützten Datenbank; keine Tokens im Browser.
- Keine Anfrage- oder Anbieterantwort-Protokollierung. Reverse-Proxy-Logs dürfen Authorization-Header nicht enthalten.
- Rate-Limits schützen Update- und Verwaltungsrouten pro Quell-IP und Prozess. Für große Installationen werden verteilte Limits, DNS-Zonenindizes und ein skalierbarer Session-Store nötig.
- Entwicklerkonto und Mock-DNS nur für lokale Entwicklung. Tests dürfen keine echten Konten oder DNS-Zonen verändern.

## Nächste Ausbauschritte

Vor einer größeren Benutzerfreigabe: Betreiberoberfläche für Sperren fremder Hosts, definierter zentraler Gerätewiderruf, kontrollierte Löschung einzelner DNS-Familien und Hostnamen sowie nachvollziehbare Ereignisprotokolle ohne Tokens. Danach Router-Kompatibilität mit realer Hardware und Monitoring der externen Dienste ergänzen.
