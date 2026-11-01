# Entwicklung

- Produkt und Startbefehle: `README.md`.
- Architektur, ZugangsWerk-Rechte und Sicherheitsgrenzen: `docs/architecture.md`.
- Ubuntu-/Git-Deployment: `docs/deployment.md`; Client-Protokoll: `docs/clients.md`.
- Node.js 24 LTS verwenden. Installation: `npm ci --ignore-scripts --no-fund --no-audit`.
- Vor Abschluss einer Codeänderung `npm run check` und `npm test` ausführen. Tests verwenden lokale HTTP-Server und simulierte Anbieter, keine echten DNS-Konten.
- Bei Setup vorhandenen Checkout verwenden. Jede Cloud-Aufgabe ist bereits isoliert; keine zusätzlichen Worktrees ohne ausdrücklichen Auftrag.
- Niemals `.env`, Tokens, SQLite-Daten oder Zugangsdaten committen. Produktionszugriff nicht durch Entwicklungslogin oder Mocks ersetzen.
- Schreibende DNS-Aufrufe nicht automatisch nach Timeouts wiederholen; fremde Records nicht übernehmen. Nur ein Serverprozess wird unterstützt.
