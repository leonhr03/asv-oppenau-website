<?php
/*
 * Kleine Schreib-Schnittstelle für das Admin-Panel.
 *
 * Aktionen (?action=…):
 *   status  GET   – ist ein Passwort eingerichtet, ist man angemeldet?
 *   login   POST  – { password }
 *   logout  POST
 *   load    GET   – alle drei JSON-Dateien samt Versions-Hash (nur angemeldet)
 *   save    POST  – { files: { news: { data: [...], version: "…" }, … } } (nur angemeldet)
 *
 * Das Passwort steht als Hash in admin/config.php (siehe config.example.php).
 * Vor jedem Überschreiben wird die alte Datei nach admin/backups/ kopiert.
 * Bilder kommen als Data-URL (Base64) direkt in news.json – es gibt keinen Datei-Upload.
 */
declare(strict_types=1);

const FILES = ['news' => 'news.json', 'dates' => 'dates.json', 'youth' => 'youth.json'];
const SITE_ROOT = __DIR__ . '/..';
const DATA_DIR = __DIR__ . '/backups';
const MAX_BACKUPS = 20;        // pro Datei
const MAX_BODY = 60000000;     // Bytes – news.json enthält die Bilder als Base64
const MAX_FAILED_LOGINS = 5;   // pro IP …
const LOGIN_WINDOW = 900;      // … innerhalb von 15 Minuten

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function respond(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function readBody(): array
{
    $raw = file_get_contents('php://input', false, null, 0, MAX_BODY + 1);
    if ($raw === false || strlen($raw) > MAX_BODY) {
        respond(413, ['error' => 'Die Anfrage ist zu groß.']);
    }
    $body = json_decode($raw, true);
    if (!is_array($body)) {
        respond(400, ['error' => 'Ungültige Anfrage.']);
    }
    return $body;
}

function requireMethod(string $method): void
{
    if ($_SERVER['REQUEST_METHOD'] !== $method) {
        respond(405, ['error' => 'Methode nicht erlaubt.']);
    }
}

function isList($value): bool
{
    return is_array($value) && $value === array_values($value);
}

/** Verzeichnis für Backups, Sperrdatei und Login-Zähler – per .htaccess nicht abrufbar. */
function ensureDataDir(): void
{
    if (!is_dir(DATA_DIR) && !mkdir(DATA_DIR, 0755) && !is_dir(DATA_DIR)) {
        respond(500, ['error' => 'Der Ordner admin/backups konnte nicht angelegt werden.']);
    }
    if (!is_file(DATA_DIR . '/.htaccess')) {
        file_put_contents(DATA_DIR . '/.htaccess', "Require all denied\n");
    }
}

/** Exklusive Sperre, damit sich zwei gleichzeitige Anfragen nicht in die Quere kommen. */
function lock()
{
    ensureDataDir();
    $handle = fopen(DATA_DIR . '/.lock', 'c');
    if (!$handle || !flock($handle, LOCK_EX)) {
        respond(500, ['error' => 'Die Sperrdatei konnte nicht geöffnet werden.']);
    }
    return $handle;
}

function fileVersion(string $kind): string
{
    $hash = @sha1_file(SITE_ROOT . '/' . FILES[$kind]);
    return $hash === false ? '' : $hash;
}

/** Prüft die Einträge einer Datei; gibt eine Fehlermeldung oder null zurück. */
function validateItems($items): ?string
{
    if (!isList($items)) {
        return 'Es wird eine Liste von Einträgen erwartet.';
    }
    foreach ($items as $index => $item) {
        $nr = $index + 1;
        if (!is_array($item) || isList($item)) {
            return "Eintrag $nr ist kein Objekt.";
        }
        if (!isset($item['title']) || !is_string($item['title']) || trim($item['title']) === '') {
            return "Eintrag $nr hat keinen Titel.";
        }
        foreach ($item as $key => $value) {
            $strings = is_array($value) ? $value : [$value];
            if (!isList($strings) || array_filter($strings, 'is_string') !== $strings) {
                return "Eintrag $nr: Feld „{$key}“ muss Text oder eine Liste von Texten sein.";
            }
        }
    }
    return null;
}

function backup(string $kind): void
{
    $source = SITE_ROOT . '/' . FILES[$kind];
    if (!is_file($source)) {
        return;
    }
    if (!copy($source, DATA_DIR . "/$kind-" . date('Ymd-His') . '-' . bin2hex(random_bytes(2)) . '.json')) {
        respond(500, ['error' => 'Das Backup konnte nicht geschrieben werden – es wurde nichts geändert.']);
    }
    $old = glob(DATA_DIR . "/$kind-*.json") ?: [];
    sort($old);
    foreach (array_slice($old, 0, max(0, count($old) - MAX_BACKUPS)) as $file) {
        @unlink($file);
    }
}

function writeJson(string $kind, array $items): void
{
    $target = SITE_ROOT . '/' . FILES[$kind];
    $json = json_encode($items, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($json === false) {
        respond(400, ['error' => FILES[$kind] . ' enthält ungültige Zeichen.']);
    }
    // Zwei statt vier Leerzeichen Einrückung, wie in den bestehenden Dateien (kleine Git-Diffs).
    $json = preg_replace_callback('/^(?: {4})+/m', fn($match) => str_repeat('  ', intdiv(strlen($match[0]), 4)), $json) . "\n";

    // Erst in eine Temp-Datei, dann umbenennen: Besucher sehen nie eine halb geschriebene Datei.
    $tmp = $target . '.tmp-' . bin2hex(random_bytes(4));
    if (file_put_contents($tmp, $json) !== strlen($json) || !rename($tmp, $target)) {
        @unlink($tmp);
        respond(500, ['error' => FILES[$kind] . ' konnte nicht geschrieben werden (Schreibrechte prüfen).']);
    }
}

/* ---------- Login-Bremse ---------- */

function attemptsFile(): string
{
    return DATA_DIR . '/.login-attempts.json';
}

/** Fehlversuche der letzten LOGIN_WINDOW Sekunden, nach (gehashter) IP. */
function recentAttempts(): array
{
    $all = json_decode((string) @file_get_contents(attemptsFile()), true);
    $cutoff = time() - LOGIN_WINDOW;
    $recent = [];
    foreach (is_array($all) ? $all : [] as $key => $times) {
        $times = array_values(array_filter((array) $times, fn($time) => is_int($time) && $time > $cutoff));
        if ($times) {
            $recent[$key] = $times;
        }
    }
    return $recent;
}

/* ---------- Dev-Modus ohne Passwort ---------- */

/**
 * Darf das Passwort übersprungen werden? Nur wenn die Seite lokal oder über
 * Tailscale aufgerufen wird – auf einer öffentlichen Domain (IONOS) greift
 * 'no_password' nie, selbst wenn die Dev-config.php versehentlich dort landet.
 */
function isPrivateHost(): bool
{
    $host = strtolower((string) ($_SERVER['HTTP_HOST'] ?? ''));
    $host = preg_replace('/:\d+$/', '', $host);          // Port abschneiden
    $host = trim($host, '[]');                            // IPv6-Klammern
    if (in_array($host, ['localhost', '127.0.0.1', '::1'], true)) {
        return true;
    }
    if (str_ends_with($host, '.ts.net')) {                // Tailscale-Name
        return true;
    }
    // Tailscale-IPs: 100.64.0.0 – 100.127.255.255
    if (preg_match('/^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/', $host, $match)) {
        return (int) $match[1] >= 64 && (int) $match[1] <= 127;
    }
    return false;
}

/* ---------- Start ---------- */

$config = is_file(__DIR__ . '/config.php') ? require __DIR__ . '/config.php' : null;
$passwordHash = is_array($config) && is_string($config['password_hash'] ?? null) ? $config['password_hash'] : '';
// Dev: 'no_password' => true in config.php schaltet die Anmeldung ab (nur lokal / über Tailscale).
$noPassword = is_array($config) && ($config['no_password'] ?? false) === true && isPrivateHost();
$configured = $passwordHash !== '' || $noPassword;

session_name('asv_admin');
session_set_cookie_params([
    'lifetime' => 0,
    'path' => '/',
    'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
    'httponly' => true,
    'samesite' => 'Strict',
]);
session_start();

if ($noPassword && empty($_SESSION['admin'])) {
    $_SESSION['admin'] = true;
    $_SESSION['csrf'] = bin2hex(random_bytes(32));
}
$loggedIn = $configured && !empty($_SESSION['admin']);
$action = $_GET['action'] ?? '';

if ($action === 'status') {
    respond(200, [
        'configured' => $configured,
        'loggedIn' => $loggedIn,
        'csrf' => $loggedIn ? $_SESSION['csrf'] : null,
    ]);
}

if ($action === 'login') {
    requireMethod('POST');
    if (!$configured) {
        respond(503, ['error' => 'Es ist noch kein Passwort eingerichtet (admin/config.php fehlt).']);
    }
    $password = readBody()['password'] ?? '';

    $handle = lock();
    $attempts = recentAttempts();
    $ip = hash('sha256', $_SERVER['REMOTE_ADDR'] ?? '');
    if (count($attempts[$ip] ?? []) >= MAX_FAILED_LOGINS) {
        respond(429, ['error' => 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.']);
    }
    if (!is_string($password) || !password_verify($password, $passwordHash)) {
        $attempts[$ip][] = time();
        file_put_contents(attemptsFile(), json_encode($attempts));
        flock($handle, LOCK_UN);
        sleep(1);
        respond(401, ['error' => 'Das Passwort stimmt nicht.']);
    }
    unset($attempts[$ip]);
    file_put_contents(attemptsFile(), json_encode($attempts));
    flock($handle, LOCK_UN);

    session_regenerate_id(true);
    $_SESSION['admin'] = true;
    $_SESSION['csrf'] = bin2hex(random_bytes(32));
    respond(200, ['loggedIn' => true, 'csrf' => $_SESSION['csrf']]);
}

if ($action === 'logout') {
    requireMethod('POST');
    $_SESSION = [];
    session_destroy();
    respond(200, ['loggedIn' => false]);
}

if (!$loggedIn) {
    respond(401, ['error' => 'Nicht angemeldet.']);
}

if ($action === 'load') {
    $files = [];
    foreach (FILES as $kind => $name) {
        $data = json_decode((string) @file_get_contents(SITE_ROOT . '/' . $name), true);
        if (!isList($data)) {
            respond(500, ['error' => "$name konnte nicht gelesen werden."]);
        }
        $files[$kind] = ['data' => $data, 'version' => fileVersion($kind)];
    }
    respond(200, ['files' => $files]);
}

if ($action === 'save') {
    requireMethod('POST');
    if (!hash_equals($_SESSION['csrf'] ?? '', $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '')) {
        respond(403, ['error' => 'Sicherheits-Token ungültig. Bitte die Seite neu laden.']);
    }

    $files = readBody()['files'] ?? null;
    if (!is_array($files) || !$files || array_diff_key($files, FILES)) {
        respond(400, ['error' => 'Unbekannte Datei.']);
    }
    foreach ($files as $kind => $file) {
        $error = validateItems($file['data'] ?? null);
        if ($error !== null) {
            respond(422, ['error' => FILES[$kind] . ": $error"]);
        }
    }

    // Erst alles prüfen, dann schreiben – entweder alle Dateien oder keine.
    $handle = lock();
    foreach ($files as $kind => $file) {
        if (($file['version'] ?? null) !== fileVersion($kind)) {
            respond(409, ['error' => FILES[$kind] . ' wurde inzwischen von anderer Stelle geändert. Bitte die Seite neu laden.']);
        }
    }
    $versions = [];
    foreach ($files as $kind => $file) {
        backup($kind);
        writeJson($kind, $file['data']);
        $versions[$kind] = fileVersion($kind);
    }
    flock($handle, LOCK_UN);
    respond(200, ['versions' => $versions]);
}

respond(404, ['error' => 'Unbekannte Aktion.']);
