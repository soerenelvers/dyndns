# Ubuntu 24.04: Einrichtung und Updates

## Voraussetzungen

- Ubuntu 24.04 LTS, Git, curl, Node.js **24 LTS** mit npm. Ubuntu 24.04 liefert standardmäßig eine ältere Node-Version; Node 24 aus einer vertrauenswürdigen offiziellen Installationsquelle verwenden. Paket-Signaturen und TLS-Prüfung beibehalten. `node --version` muss `v24.*` ergeben.
- Vorhandener Apache- oder Nginx-Webserver mit einer eigenen HTTPS-Anwendungsdomain, beispielsweise `dyndns.example.com`. Betrieb in einem URL-Unterpfad wird nicht unterstützt.
- Vorhandene DNS-Zone bei Contabo, beispielsweise `example.com`. Die autoritativen Nameserver müssen diese Zone tatsächlich bei Contabo bedienen; eine dort registrierte Domain allein reicht nicht.
- Reservierter Bereich, beispielsweise `dyn.example.com`. Darunter keine anderen Anwendungen oder manuell verwalteten Hostnamen betreiben. Keine separate Delegation dieser Unterdomain einrichten, solange die Einträge in der übergeordneten Contabo-Zone liegen.
- Ausgehendes HTTPS zu `auth.contabo.com`, `api.contabo.com` und `accounts.delevel.de`; für Updates außerdem GitHub und die npm-Registry.

Die untenstehenden Befehle sind Serveranweisungen. Sie wurden in der Cloud nicht auf deinem Produktivserver ausgeführt.

## 1. Repository und Dienstkonto

Als Administrator einen Checkout und ein unprivilegiertes Laufzeitkonto vorbereiten. `<deploy-user>` ist dein normaler Benutzer mit GitHub-Lesezugriff und sudo-Recht für den Dienstneustart. Einen gegebenenfalls vorhandenen Checkout weiterverwenden.

```sh
sudo useradd --system --home-dir /var/lib/dyndns --shell /usr/sbin/nologin dyndns
sudo install -d -o <deploy-user> -g <deploy-user> /opt/dyndns
git clone https://github.com/soerenelvers/dyndns.git /opt/dyndns
cd /opt/dyndns
npm ci --ignore-scripts --no-fund --no-audit
npm run check
npm test
```

Der Laufzeitbenutzer braucht Leserechte auf `/opt/dyndns`, aber keine Schreibrechte am Programmcode. Die systemd-Vorlage erwartet Node unter `/usr/bin/node`; `command -v node` prüfen und `ExecStart` bei abweichendem systemweit zugänglichem Pfad anpassen. Eine Node-Installation im privaten Home-Verzeichnis ist mit `ProtectHome=true` nicht geeignet.

## 2. Contabo und Domain konfigurieren

Im Contabo-Kundenbereich unter **API** Client-ID, Client-Secret, API-Benutzer und ein eigenes API-Passwort einrichten. Das API-Passwort ist nicht automatisch das Kennwort des Kundenbereichs. Die Schnittstelle verwendet den von Contabo dokumentierten Passwort-Grant für dieses API-Konto.

```sh
sudo install -m 600 -o root -g root deploy/production.env.example /etc/dyndns.env
sudoedit /etc/dyndns.env
```

Alle leeren Felder und Beispieldomains ersetzen. `SESSION_SECRET` aus mindestens 48 zufälligen Zeichen erzeugen, beispielsweise mit `openssl rand -hex 48`, und sicher eintragen. `/etc/dyndns.env` gehört weder in Git noch in das Webverzeichnis. systemd liest diese Datei als root und übergibt die Werte an den unprivilegierten Prozess. Werte mit Sonderzeichen gemäß systemd-EnvironmentFile-Syntax in Anführungszeichen setzen; keine Shell-Befehle in die Datei schreiben.

`DNS_ZONE=example.com` und `DYNDNS_DOMAIN=dyn.example.com` erlauben etwa `zuhause.dyn.example.com`. Root-Zone und Anwendungsdomain werden nicht als frei wählbare Update-Ziele angeboten. Der Dienst erzeugt die benötigten A-/AAAA-Einträge beim ersten Update. Fremde bestehende A-/AAAA-Einträge werden nicht übernommen; ein CNAME am Hostnamen blockiert Updates.

## 3. ZugangsWerk verbinden

Quelle: [soerenelvers/zugangswerk](https://github.com/soerenelvers/zugangswerk), Integrationsdokumentation 0.3.5.

1. Unter **Anwendungen → Anwendung verbinden** den Client `dyndns` mit Anwendungsadresse `https://dyndns.example.com` und exakter Callback-URL `https://dyndns.example.com/auth/callback` einrichten.
2. Client-ID und Client-Secret in `/etc/dyndns.env` eintragen. Standard-Issuer: `https://accounts.delevel.de/identity/realms/zugangswerk`.
3. Rechte `dyndns.read` und `dyndns.write` im Berechtigungskatalog anlegen und den gewünschten Rollen zuordnen. Für Benutzer, die Hostnamen verwalten sollen, beide Rechte vergeben. Auch Administratorrollen benötigen die ausdrückliche Zuordnung.
4. Gewünschte Benutzer für diesen Client freischalten. Eine erfolgreiche zentrale Anmeldung allein erteilt keine DynDNS-Rechte.

Alternativ lässt sich der Client mit dem Einmal-Registrierungstoken und dem Skript aus dem ZugangsWerk-Repository anlegen. Das Token nur dort serverseitig einlösen und die resultierenden Werte sicher übernehmen. Der DynDNS-Dienst benötigt danach ausschließlich die OIDC-Konfiguration, kein dauerhaftes Registrierungstoken.

Tokens bleiben in serverseitigen SQLite-Sessions, der Browser bekommt ein HttpOnly-Cookie. Berechtigungen werden bei jeder geschützten Verwaltungsanfrage online geprüft; Ausfälle erteilen keinen Zugriff. Lokales Abmelden beendet die DynDNS-Sitzung, nicht die zentrale ZugangsWerk-Sitzung.

## 4. Dienst und HTTPS einrichten

```sh
sudo install -m 644 deploy/dyndns.service /etc/systemd/system/dyndns.service
sudo systemctl daemon-reload
sudo systemctl enable --now dyndns
sudo systemctl status dyndns
```

systemd legt `/var/lib/dyndns` für Daten und Sessions an. Bei Startfehlern `sudo journalctl -u dyndns -n 50` verwenden. Konfiguration und Zugangsdaten nicht in Supportausgaben kopieren.

Die passende Vorlage in den vorhandenen **HTTPS**-VirtualHost übernehmen:

- [Nginx](../deploy/nginx.conf): anschließend `sudo nginx -t` und den Webserver neu laden.
- [Apache](../deploy/apache.conf): Module `proxy`, `proxy_http`, `headers` aktivieren; anschließend `sudo apachectl configtest` und den Webserver neu laden.

HTTP am öffentlichen Webserver auf HTTPS umleiten. TLS-Zertifikate über die vorhandene Serververwaltung einrichten. Node lauscht ausschließlich auf `127.0.0.1:3000`; diesen Port nicht öffentlich weiterleiten. Die Vorlagen überschreiben Forwarding-Header. Bei zusätzlichem CDN/Proxy die Vertrauenskette bewusst konfigurieren; keine vom Internet frei gelieferten Quell-IP-Header übernehmen.

```sh
curl --fail https://dyndns.example.com/healthz
```

Erwartet: `{"status":"ok","dnsProvider":"contabo"}`. Dieser Check prüft Prozess und SQLite, **keine** Anmeldung, DNS-Berechtigung oder DNS-Auflösung.

## 5. Live-Abnahme

1. Anmeldung über ZugangsWerk durchführen; unberechtigte Benutzer müssen abgewiesen werden.
2. Testhostname anlegen, Update-Token im Router oder einem sicheren HTTP-Client hinterlegen und die eigene öffentliche IP übertragen.
3. Antwort `good` und anschließend `nochg` prüfen. Öffentliche DNS-Auflösung mit `dig A <hostname>` beziehungsweise `dig AAAA <hostname>` nach Ablauf der TTL prüfen; bei Bedarf direkt den autoritativen Contabo-Nameserver abfragen.
4. Token wechseln: alter Token muss `badauth` liefern. Pausieren muss weitere Updates ebenfalls abweisen.
5. Entzug der ZugangsWerk-Freigabe muss die nächste Verwaltungsanfrage blockieren. Router-Tokens sind eigene Gerätezugänge und müssen zusätzlich lokal widerrufen werden (siehe Architektur).

## Updates per Git-Pull

Die Anwendung braucht keinen Build-Schritt. Nach einer Änderung an Node-Code muss der Prozess neu starten; Git-Pull allein aktualisiert einen laufenden Prozess nicht. Vom Deployment-Benutzer aus:

```sh
cd /opt/dyndns
bash scripts/update-server.sh
```

Das Skript bricht bei lokalen Änderungen ab, zieht `main` ohne Merge, installiert exakt aus der Lockdatei, prüft Syntax und Tests, startet den Dienst neu und prüft die lokale Gesundheit. sudo fragt gegebenenfalls nach dem Passwort. Für Automatisierung kann der Serveradministrator ein eng begrenztes sudo-Recht nur für diesen Dienstneustart einrichten.

Falls Tests fehlschlagen, wird der Dienst nicht neu gestartet. Der Checkout enthält dann bereits den neuen Stand; vor erneutem Deployment die Ursache klären. Es gibt keine automatische Rücksetzung. Vor späteren Datenbankmigrationen eine Sicherung erstellen und die jeweilige Release-Anleitung beachten.

## Sicherung und Grenzen

- `/etc/dyndns.env` getrennt und verschlüsselt sichern.
- SQLite mit der Backup-Funktion sichern oder den Dienst kurz stoppen und dann `/var/lib/dyndns` vollständig kopieren. Eine einzelne Datei im laufenden WAL-Betrieb zu kopieren ist kein verlässliches Backup.
- SQLite-Dateien enthalten Session-Tokens. Sicherungen genauso schützen wie Zugangsdaten.
- Nach Verlust der Datenbank sind DNS-Record-Zuordnungen verloren. Bestehende Einträge werden aus Schutz vor Fremdänderungen nicht automatisch übernommen; manuelle Wiederherstellung beziehungsweise Bereinigung im DNS-Konto ist erforderlich.
- Nur einen Prozess betreiben; kein Cluster/PM2-Mehrprozessmodus. Sperren und Rate-Limits gelten pro Prozess.
- Node.js 24.x und Abhängigkeiten regelmäßig aktualisieren und die Tests vor dem Deployment ausführen.
