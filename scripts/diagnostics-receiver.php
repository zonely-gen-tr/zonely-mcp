<?php
declare(strict_types=1);

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function finish(int $status): void
{
    http_response_code($status);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
    header('Content-Type: application/json');
    echo '{"ready":true,"schema":1}';
    exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: GET, POST');
    finish(405);
}
if (strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '', 2)[0])) !== 'application/json') finish(415);
if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 512) finish(413);
$body = file_get_contents('php://input', false, null, 0, 513);
if ($body === false || strlen($body) > 512) finish(413);
$report = json_decode($body, true, 4);
$codes = [
    'admin_route_missing', 'admin_integration_incomplete', 'verification_failed', 'apply_incomplete',
    'upload_rejected', 'panel_unavailable', 'unconfirmed', 'apply_rejected', 'operation_failed',
    'sign_in_required', 'timeout', 'theme_sync_failed', 'revision_conflict', 'render_failed',
    'slow_operation', 'update_failed',
];
if (!is_array($report) || count($report) !== 4 || ($report['schema'] ?? null) !== 1 ||
    !is_string($report['version'] ?? null) || !preg_match('/^\d{1,8}\.\d{1,8}\.\d{1,8}$/D', $report['version']) ||
    !is_string($report['tool'] ?? null) || !preg_match('/^zonely_[a-z_]{1,52}$/D', $report['tool']) ||
    !in_array($report['code'] ?? null, $codes, true)) finish(400);

$directory = dirname(__DIR__, 3) . '/.zonely-mcp-diagnostics';
if (!is_dir($directory) || !is_writable($directory)) finish(503);
$minute = gmdate('Y-m-d\TH:i\Z');
$file = $directory . '/' . gmdate('Y-m-d') . '.jsonl';
umask(0077);
$handle = @fopen($file, 'a+b');
if ($handle === false) finish(503);
if (!flock($handle, LOCK_EX)) { fclose($handle); finish(503); }

$size = (int) (fstat($handle)['size'] ?? 0);
$recent = 0;
$tailLength = min($size, 32768);
if ($tailLength > 0) {
    fseek($handle, -$tailLength, SEEK_END);
    $tail = fread($handle, $tailLength);
    if ($tail === false) { fclose($handle); finish(503); }
    $recent = substr_count($tail, '"minute":"' . $minute . '"');
}
$line = json_encode([
    'minute' => $minute,
    'schema' => 1,
    'version' => $report['version'],
    'tool' => $report['tool'],
    'code' => $report['code'],
], JSON_UNESCAPED_SLASHES) . "\n";
if ($recent >= 90 || $size + strlen($line) > 1024 * 1024) {
    fclose($handle);
    header('Retry-After: 60');
    finish(429);
}
if (fwrite($handle, $line) !== strlen($line) || !fflush($handle)) {
    ftruncate($handle, $size);
    fclose($handle);
    finish(503);
}
fclose($handle);
finish(204);
