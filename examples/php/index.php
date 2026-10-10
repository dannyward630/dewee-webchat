<?php
declare(strict_types=1);

// Under `php -S … router.php` the locally built bundle is served at /dewee-webchat.js;
// anywhere else the page loads the widget from the CDN.
$cdn = 'https://webchat-cdn.dewee.sh/dewee-webchat@latest/dewee-webchat.js';
$local = PHP_SAPI === 'cli-server' && is_file(__DIR__ . '/../../packages/dewee-webchat/dist/dewee-webchat.js');
$base = rtrim(str_replace('\\', '/', dirname((string) ($_SERVER['SCRIPT_NAME'] ?? '/'))), '/');
$src = $local ? '/dewee-webchat.js' : $cdn;
$endpoint = $base . '/api/dewee.php';
$e = static fn (string $s): string => htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
?>
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>dewee-webchat · PHP</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 680px; margin: 64px auto; padding: 0 16px; color: #1b1f4b; }
      code { background: #f1f0fb; padding: 2px 6px; border-radius: 6px; }
    </style>
  </head>
  <body>
    <h1>PHP + dewee-webchat</h1>
    <p>The chat bubble in the corner talks to <code><?= $e($endpoint) ?></code>, served by <code>api/dewee.php</code>.</p>
    <p>Widget script: <code><?= $e($src) ?></code>.
      If the CDN is unreachable, build the package (<code>pnpm build</code>) and serve
      <code>packages/dewee-webchat/dist/dewee-webchat.js</code> from your own site instead.</p>

    <script
      src="<?= $e($src) ?>"
      data-endpoint="<?= $e($endpoint) ?>"
      data-title="Dewee assistant"
      data-suggestions="What is Dewee?|How do I add this chat to my site?"
      defer
    ></script>
  </body>
</html>
