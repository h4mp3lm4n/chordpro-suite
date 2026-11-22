ChordPro Studio & Live Performance Suite (v2)
=============================================

1. LIVE-BÜHNE: IPAD AM KLAVIER <-> LAPTOP AM BEAMER (100% OFFLINE, iOS-SICHER!)
-------------------------------------------------------------------------------
Empfohlene Profi-Variante (kein Internet, kein WebRTC, kein iOS-Block):
  a) Laptop & iPad ins selbe WLAN oder einen Hotspot (z. B. iPhone/Laptop-Hotspot) verbinden.
  b) Auf dem Laptop `start-stage-server.bat` (Windows) oder `start-stage-server.sh` (macOS/Linux)
     per Doppelklick starten (benoetigt Node.js >= 18).
  c) Im Browser am Laptop oben rechts auf "Remote" -> "Anzeige (Laptop / Beamer)" klicken.
     Optional: "QR auf Beamer zeigen" druecken.
  d) Mit der iPad-Kamera den QR-Code scannen -> Safari oeffnet direkt die verbundene Steuerung!
  e) Optional am Laptop unter Live Stage -> Darstellung -> Beamer-Anzeige z. B.
     "Publikum (Nur Text, zentriert)" waehlen, waehrend am iPad Akkorde, Hinweise,
     Sektions-Sprungleiste, Metronom & "Schwarz"-Button sichtbar bleiben.

Tipp – gemeinsamer Song-Ordner:
  Lege einfach einen Unterordner `songs` neben `server.mjs` an und kopiere deine .cho-Dateien
  hinein (oder starte `node server.mjs --songs "C:\Pfad\zu\Songs"`).
  Dann haben Laptop UND iPad automatisch exakt dieselbe Song-Bibliothek!

2. ONLINE-BETRIEB (OHNE LOKALEN SERVER, ALS PWA)
------------------------------------------------
  a) Diesen gesamten Ordner auf einen HTTPS-Webspace legen (z. B. Netlify Drop / GitHub Pages).
  b) Die Adresse in Safari (iPad/iOS) oder Chrome oeffnen -> "Zum Home-Bildschirm".
  c) Die App erkennt automatisch, dass kein lokaler Server laeuft, und nutzt fuer die
     Fernsteuerung einen iOS-kompatiblen WSS-Relay (Port 443/TLS statt WebRTC) inkl. QR-Code.
  d) Fuer maximale Profi-Zuverlaessigkeit ueber eigenes Port-443-Relay liegt eine fertige
     Cloudflare-Worker-Vorlage in `cloud-relay/worker.js` bei.

3. UPDATES & BACKUP
-------------------
  - Songs liegen jetzt sicher in IndexedDB (kein 5-MB-localStorage-Limit mehr).
  - Bestehende Songs aus v1 werden beim ersten Start automatisch uebernommen.
  - Bei Updates zeigt die App oben automatisch ein Banner "Jetzt aktualisieren".
  - Trotzdem regelmaessig in der Bibliothek "Backup" nutzen!
