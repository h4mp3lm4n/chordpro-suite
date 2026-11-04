ChordPro Studio - installierbare Web-App (PWA)

1. Ordner auf einen HTTPS-Webspace legen, z. B.
   - Netlify Drop (app.netlify.com/drop): Ordner per Drag & Drop hochladen
   - GitHub Pages oder eigener Webserver
2. Die Adresse in Safari (iOS) oder Chrome (Android) oeffnen.
3. iOS: Teilen-Symbol -> "Zum Home-Bildschirm". Android: Menue -> "App installieren".
4. Einmal online oeffnen; danach laeuft die App offline (Service Worker cached die Seite und die Bibliotheken).

Hinweis: Lokal per Doppelklick (file://) funktionieren Service Worker und Installation nicht.
Songs liegen im Speicher des jeweiligen Browsers/Geraets - regelmaessig "Backup" bzw. "Speichern" nutzen.

UPDATE
1. Neue index.html (und ggf. sw.js) in den Ordner/Repository hochladen und die alte Version ersetzen.
2. App einmal online oeffnen und ein paar Sekunden warten (die neue Version wird im Hintergrund geladen).
3. App ganz schliessen (iOS: im App-Umschalter nach oben wischen) und neu oeffnen - dann laeuft die neue Version.
   Manchmal sind dafuer zwei Neustarts noetig.
4. Songs, Setlists und Einstellungen bleiben erhalten, solange die Adresse (Domain + Pfad) gleich bleibt.
   Vor jedem Update: in der Bibliothek "Backup (JSON)" sichern.
