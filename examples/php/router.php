<?php
// Router for PHP's built-in server:
//   php -S 127.0.0.1:8790 -t examples/php examples/php/router.php
// Serves the locally built widget at /dewee-webchat.js and sends /api/dewee* to the backend.
declare(strict_types=1);

$path = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);

if ($path === '/dewee-webchat.js') {
    $bundle = __DIR__ . '/../../packages/dewee-webchat/dist/dewee-webchat.js';
    if (!is_file($bundle)) {
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo "Widget bundle not built. Run `pnpm build` in packages/dewee-webchat, or use the CDN script.\n";
        return true;
    }
    header('Content-Type: application/javascript; charset=utf-8');
    header('Cache-Control: no-cache');
    readfile($bundle);
    return true;
}

if (preg_match('#^/api/dewee(\.php)?(/|$)#', $path)) {
    require __DIR__ . '/api/dewee.php';
    return true;
}

return false; // let the built-in server serve index.php and static files
