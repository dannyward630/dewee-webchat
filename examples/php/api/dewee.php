<?php
// dewee-webchat backend endpoint: /api/dewee.php/{config,session,chat,history}.
// The gateway token stays on the server; the browser only talks to this file.
declare(strict_types=1);

require __DIR__ . '/../../../php/dewee-webchat.php';

// Local convenience: read examples/php/.env when present (real env vars take precedence).
DeweeWebchat::loadEnvFile(__DIR__ . '/../.env');

DeweeWebchat::handle();
