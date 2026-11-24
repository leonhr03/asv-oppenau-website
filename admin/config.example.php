<?php
/*
 * Vorlage für admin/config.php (steht in .gitignore und wird NICHT automatisch
 * deployt – einmalig von Hand per SFTP in den Ordner admin/ hochladen).
 *
 * Passwort-Hash erzeugen (Terminal, macOS/Linux):
 *
 *     htpasswd -bnBC 12 "" 'MEIN-PASSWORT' | tr -d ':\n'
 *
 * Die Ausgabe ($2y$12$…) unten eintragen. Wichtig: einfache Anführungszeichen,
 * sonst deutet PHP die $-Zeichen als Variablen.
 */
return [
    'password_hash' => '',
    // Nur für die Dev-Seite: true überspringt die Anmeldung. Wirkt ausschließlich
    // bei Aufruf über localhost oder Tailscale, nie auf der öffentlichen Domain.
    // 'no_password' => true,
];
