# Router und Clients anbinden

Nach der Anmeldung einen Hostnamen anlegen. Der Token wird einmalig angezeigt. Benutzername ist immer der vollständige Hostname, Passwort ist dessen Token. Ausschließlich HTTPS und HTTP Basic Authentication verwenden.

```text
GET https://dyndns.example.com/nic/update?hostname=zuhause.dyn.example.com&myip=<öffentliche-ip>
Authorization: Basic <Base64 aus hostname:token>
```

Token niemals in die URL schreiben. URL-Zugangsdaten werden vom Dienst nicht ausgewertet. In einem Client, der Zugangsdaten nur in URLs unterstützt, diesen Modus nicht verwenden.

## FRITZ!Box / benutzerdefinierter DynDNS-Anbieter

Im Menü für benutzerdefiniertes DynDNS eintragen; Bezeichnungen hängen von der FRITZ!OS-Version ab:

| Feld | Wert |
| --- | --- |
| Update-URL | `https://dyndns.example.com/nic/update?hostname=<domain>&myip=<ipaddr>` |
| Domainname | Vollständiger angelegter Hostname |
| Benutzername | Derselbe vollständige Hostname |
| Kennwort | Update-Token |

Für IPv6 kann ein unterstützter Router `&myipv6=<ip6addr>` ergänzen. Ob diese Platzhalter und Basic Authentication unterstützt werden, am konkreten Router prüfen; Hardware wurde in der Cloud nicht getestet.

## Parameter

- `hostname`: genau ein angelegter Hostname, keine Listen oder Wildcards.
- `myip`: öffentliche IPv4 oder IPv6. IPv6 wird normalisiert; IPv4 muss vier dezimale Bestandteile ohne führende Nullen enthalten.
- `myipv6`: optional eine zusätzliche öffentliche IPv6-Adresse.
- Fehlen beide IP-Parameter, wird die Quell-IP verwendet. Der Reverse Proxy muss Quell-IP-Header sicher überschreiben.

Nicht angegebene IP-Familien bleiben unverändert. Private, lokale, Multicast-, Dokumentations- und sonstige von der IP-Bibliothek als nicht öffentlich erkannte Adressen werden abgewiesen. Ein IPv4-Update löscht keinen alten AAAA-Eintrag; nicht mehr benötigte Familien müssen aktuell im Contabo-Portal entfernt werden.

Router sollen bei IP-Wechsel und höchstens alle fünf Minuten aktualisieren, nicht in kurzen Dauerschleifen. Limit: 60 Update-Anfragen pro Minute und Quell-IP. Mehrere Clients hinter derselben IP teilen das Limit. Der Dienst prüft den aktuellen Anbieterstand auch bei gleicher IP.

## Antworten

| HTTP | Text | Bedeutung |
| --- | --- | --- |
| 200 | `good <ip>` | DNS-Eintrag erfolgreich angelegt oder geändert |
| 200 | `nochg <ip>` | Eintrag und TTL stimmen bereits |
| 401 | `badauth` | Token oder Benutzername falsch, Host unbekannt oder pausiert |
| 400 | `notfqdn` | Hostname fehlt oder hat ungültiges Parameterformat |
| 400 | `dnserr` | IP-Parameter ungültig |
| 429 | `911` | Anfragelimit; Retry-After beachten |
| 503 | `911` | Anbieterfehler oder kollidierender DNS-Eintrag; später erneut versuchen und Konfiguration prüfen |

Bei zwei IP-Familien werden erfolgreiche Teilupdates sofort gespeichert. Schlägt die zweite Familie fehl, lautet die Gesamtantwort `911`; die erste Änderung kann bereits wirksam sein. Nach Netzfehlern werden schreibende Anbieteranfragen nicht automatisch wiederholt. Hat Contabo einen Eintrag angelegt, aber die Antwort ging verloren, kann die unbekannte Zuordnung einen manuellen Eingriff erfordern. Keine fremden Einträge zur Fehlerbehebung blind löschen.
