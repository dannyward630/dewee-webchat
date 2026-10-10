<?php
/**
 * dewee-webchat PHP backend — single file, no dependencies (PHP >= 8.1, ext-openssl, ext-json).
 *
 *   require __DIR__ . '/dewee-webchat.php';
 *   DeweeWebchat::handle();                       // options from environment variables
 *   DeweeWebchat::handle(['agents' => ['support'], ...]); // or explicit options
 *
 * Routes by the last path segment, so it works as /api/dewee.php/chat (PATH_INFO) or behind a
 * rewrite such as /api/dewee/chat: GET config | POST session | POST chat (SSE) | GET history | OPTIONS.
 * Implements docs/http-contract.md; mirrors the TypeScript handler in dewee-webchat/server.
 */

declare(strict_types=1);

final class DeweeGatewayError extends RuntimeException
{
    public function __construct(string $message, public readonly ?string $gatewayCode = null)
    {
        parent::__construct($message);
    }
}

final class DeweeWebchat
{
    public const VERSION = '0.1.1';
    public const HEADER_GATEWAY_URL = 'x-dewee-gateway-url';
    public const HEADER_GATEWAY_TOKEN = 'x-dewee-gateway-token';

    private const ID_RE = '/^[A-Za-z0-9_-]{6,64}$/';
    private const AGENT_RE = '/^[A-Za-z0-9_.:-]{1,64}$/';
    private const VISITOR_RE = '/^[A-Za-z0-9_-]{8,64}$/';
    private const JSON_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE;
    private const RATE_LIMITS = ['chat' => [20, 60_000], 'session' => [10, 600_000]];

    /** @var array<string, mixed> */
    private array $o;
    private string $secret;
    /** @var list<array{id: string, name?: string}> */
    private array $staticAgents;
    private bool $wildcardAgents;
    /** @var array{allowedHosts?: list<string>}|null */
    private ?array $byo;

    /**
     * Handles the current request and writes the response.
     *
     * @param array<string, mixed>|null $options Same keys as the TS DeweeHandlerOptions; null = read env.
     */
    public static function handle(?array $options = null): void
    {
        (new self($options ?? self::optionsFromEnv()))->run();
    }

    /**
     * Reads options from environment variables (getenv + $_ENV), same names as optionsFromEnv() in TS.
     *
     * @param array<string, string>|null $env
     * @param array<string, mixed> $overrides null values never erase env-derived values
     * @return array<string, mixed>
     */
    public static function optionsFromEnv(?array $env = null, array $overrides = []): array
    {
        $env ??= array_merge($_ENV, getenv());
        $get = static fn (string $k): ?string => isset($env[$k]) && is_string($env[$k]) && $env[$k] !== '' ? $env[$k] : null;
        $list = static function (?string $v): ?array {
            if ($v === null) {
                return null;
            }
            return array_values(array_filter(array_map('trim', explode(',', $v)), static fn ($s) => $s !== ''));
        };
        $agentsRaw = $get('DEWEE_AGENTS');
        $originsRaw = $get('DEWEE_ALLOWED_ORIGINS');
        $byoHosts = $list($get('DEWEE_CLIENT_CREDENTIAL_HOSTS'));
        $o = [
            'gatewayUrl' => $get('DEWEE_GATEWAY_URL') ?? $get('GOCLAW_GATEWAY_URL'),
            'token' => $get('DEWEE_GATEWAY_TOKEN') ?? $get('GOCLAW_GATEWAY_TOKEN'),
            'tenantId' => $get('DEWEE_TENANT_ID'),
            'secret' => $get('DEWEE_WEBCHAT_SECRET'),
            'agents' => $agentsRaw !== null && trim($agentsRaw) === '*' ? '*' : $list($agentsRaw),
            'defaultAgent' => $get('DEWEE_DEFAULT_AGENT'),
            'allowedOrigins' => $originsRaw !== null && trim($originsRaw) === '*' ? '*' : $list($originsRaw),
            'allowClientCredentials' => $get('DEWEE_ALLOW_CLIENT_CREDENTIALS') === 'true'
                ? ($byoHosts ? ['allowedHosts' => $byoHosts] : true)
                : false,
            'turnstile' => $get('TURNSTILE_SITE_KEY') !== null && $get('TURNSTILE_SECRET_KEY') !== null
                ? ['siteKey' => $get('TURNSTILE_SITE_KEY'), 'secretKey' => $get('TURNSTILE_SECRET_KEY')]
                : null,
        ];
        foreach ($overrides as $k => $v) {
            if ($v !== null) {
                $o[$k] = $v;
            }
        }
        return $o;
    }

    /**
     * Optional helper: loads KEY=VALUE lines from a dotenv file into the environment.
     * Existing environment variables win. Supports comments, `export`, and single/double quotes.
     */
    public static function loadEnvFile(string $path): void
    {
        if (!is_file($path) || !is_readable($path)) {
            return;
        }
        $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
        foreach ($lines as $line) {
            if (!preg_match('/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/', $line, $m)) {
                continue;
            }
            $v = $m[2];
            if (preg_match('/^"(.*)"$/s', $v, $q)) {
                $v = stripcslashes($q[1]);
            } elseif (preg_match("/^'(.*)'$/s", $v, $q)) {
                $v = $q[1];
            } else {
                $v = preg_replace('/\s+#.*$/', '', $v) ?? $v;
            }
            if (getenv($m[1]) === false && !isset($_ENV[$m[1]])) {
                putenv("{$m[1]}={$v}");
                $_ENV[$m[1]] = $v;
            }
        }
    }

    /** @param array<string, mixed> $options */
    private function __construct(array $options)
    {
        $this->o = array_merge([
            'maxMessageLength' => 4000,
            'userIdPrefix' => 'webchat-',
            'sessionTtlMs' => 30 * 24 * 3600 * 1000,
            'timeoutMs' => 180000,
        ], array_filter($options, static fn ($v) => $v !== null));

        $this->secret = is_string($this->o['secret'] ?? null) && $this->o['secret'] !== ''
            ? $this->o['secret']
            : self::fallbackSecret();

        $agents = $this->o['agents'] ?? [];
        $this->wildcardAgents = $agents === '*';
        $this->staticAgents = [];
        if (is_array($agents)) {
            foreach ($agents as $a) {
                if (is_string($a)) {
                    $this->staticAgents[] = ['id' => $a];
                } elseif (is_array($a) && isset($a['id']) && is_string($a['id'])) {
                    $this->staticAgents[] = isset($a['name']) && is_string($a['name'])
                        ? ['id' => $a['id'], 'name' => $a['name']]
                        : ['id' => $a['id']];
                }
            }
        }
        $cc = $this->o['allowClientCredentials'] ?? false;
        $this->byo = $cc ? ($cc === true ? [] : (array) $cc) : null;
    }

    /**
     * PHP has no long-lived process, so an in-memory ephemeral secret would invalidate every
     * token on the next request. Persist a random one in the temp dir instead and warn.
     */
    private static function fallbackSecret(): string
    {
        error_log('[dewee-webchat] No secret configured: using a generated one stored in the temp dir. Set DEWEE_WEBCHAT_SECRET.');
        $file = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'dewee-webchat-secret';
        $s = @file_get_contents($file);
        if (is_string($s) && strlen($s) >= 32) {
            return $s;
        }
        $s = self::randomId(32);
        if (@file_put_contents($file, $s, LOCK_EX) !== false) {
            @chmod($file, 0600);
        }
        return $s;
    }

    // ---------------------------------------------------------------- routing

    private function run(): void
    {
        $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
        try {
            if ($method === 'OPTIONS') {
                http_response_code(204);
                $this->sendHeaders($this->corsHeaders());
                return;
            }
            if (!$this->originAllowed()) {
                $this->fail(403, 'Origin not allowed', 'forbidden_origin');
                return;
            }
            $path = (string) ($_SERVER['PATH_INFO'] ?? '');
            if ($path === '') {
                $path = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
            }
            $segments = explode('/', rtrim($path, '/'));
            $action = end($segments);

            match (true) {
                $method === 'GET' && $action === 'config' => $this->handleConfig(),
                $method === 'POST' && $action === 'session' => $this->handleSession(),
                $method === 'POST' && $action === 'chat' => $this->handleChat(),
                $method === 'GET' && $action === 'history' => $this->handleHistory(),
                default => $this->fail(404, 'Not found', 'not_found'),
            };
        } catch (Throwable $e) {
            error_log('[dewee-webchat] ' . $e->getMessage());
            if (!headers_sent()) {
                $this->fail(500, $e->getMessage() !== '' ? $e->getMessage() : 'Internal error', 'internal');
            }
        }
    }

    // ---------------------------------------------------------------- handlers

    private function handleConfig(): void
    {
        [$creds, $isByo, $error] = $this->resolveCreds();
        if ($error !== null) {
            $this->fail(400, $error, 'bad_credentials');
            return;
        }
        try {
            $agents = $this->agentsFor($creds, $isByo);
        } catch (Throwable $e) {
            $this->fail(502, $e->getMessage(), 'gateway_error');
            return;
        }
        $body = [
            'agents' => $agents,
            'defaultAgent' => (!$isByo && !empty($this->o['defaultAgent']) ? $this->o['defaultAgent'] : null) ?? ($agents[0]['id'] ?? ''),
            'allowAgentSwitch' => isset($this->o['allowAgentSwitch']) ? (bool) $this->o['allowAgentSwitch'] : ($isByo || count($agents) > 1),
            'allowClientCredentials' => $this->byo !== null,
            'turnstileSiteKey' => $this->o['turnstile']['siteKey'] ?? null,
            'maxMessageLength' => $this->o['maxMessageLength'],
            'version' => self::VERSION,
        ];
        $this->json(self::withoutNulls($body));
    }

    private function handleSession(): void
    {
        $ip = $this->clientIp();
        if (!$this->rateLimit($ip, 'session')) {
            $this->fail(429, 'Too many sessions, slow down', 'rate_limited');
            return;
        }
        $body = $this->readJsonBody() ?? [];
        if (!empty($this->o['turnstile'])) {
            $tt = $body['turnstileToken'] ?? null;
            if (!is_scalar($tt) || (string) $tt === '' || !self::verifyTurnstile((string) $this->o['turnstile']['secretKey'], (string) $tt, $ip)) {
                $this->fail(403, 'Verification failed', 'turnstile_failed');
                return;
            }
        }
        // Refresh an existing visitor instead of minting a new identity, so history survives.
        $previous = isset($body['token']) && is_string($body['token']) ? self::verifyVisitorToken($this->secret, $body['token']) : null;
        $visitorId = $previous['v'] ?? self::randomId(16);
        $expiresAt = self::nowMs() + (int) $this->o['sessionTtlMs'];
        $this->json([
            'visitorId' => $visitorId,
            'token' => self::signVisitorToken($this->secret, ['v' => $visitorId, 'exp' => $expiresAt]),
            'expiresAt' => $expiresAt,
        ]);
    }

    private function handleChat(): void
    {
        $visitorId = $this->visitorFromRequest();
        if ($visitorId === null) {
            $this->fail(401, 'Missing or expired visitor session', 'unauthorized');
            return;
        }
        if (!$this->rateLimit($visitorId . '|' . $this->clientIp(), 'chat')) {
            $this->fail(429, 'Too many messages, please wait a moment', 'rate_limited');
            return;
        }
        [$creds, $isByo, $error] = $this->resolveCreds();
        if ($error !== null) {
            $this->fail(400, $error, 'bad_credentials');
            return;
        }
        if ($creds === null) {
            $this->fail(500, 'Gateway is not configured', 'not_configured');
            return;
        }
        $body = $this->readJsonBody();
        $message = is_string($body['message'] ?? null) ? self::jsTrim($body['message']) : '';
        if ($message === '') {
            $this->fail(400, 'Message is required');
            return;
        }
        $max = (int) $this->o['maxMessageLength'];
        if (self::utf16Length($message) > $max) {
            $this->fail(413, "Message exceeds {$max} characters", 'too_long');
            return;
        }
        $cid = $body['conversationId'] ?? null;
        $conversationId = is_string($cid) && preg_match(self::ID_RE, $cid) ? $cid : self::randomId(9);
        $requested = $body['agent'] ?? null;
        $agent = $this->pickAgent(is_string($requested) ? $requested : null, $creds, $isByo);
        if ($agent === null) {
            $this->fail(403, 'Agent not allowed', 'agent_not_allowed');
            return;
        }
        $sessionKey = self::buildSessionKey($agent, "webchat-{$visitorId}-{$conversationId}");

        $this->beginEventStream();
        $lastWrite = microtime(true);
        $aborted = false;
        $write = static function (string $chunk) use (&$lastWrite, &$aborted): bool {
            if ($aborted) {
                return false;
            }
            echo $chunk;
            @flush();
            $lastWrite = microtime(true);
            if (connection_aborted()) {
                $aborted = true;
            }
            return !$aborted;
        };
        $emit = static fn (array $e): bool => $write('data: ' . json_encode(self::withoutNulls($e), self::JSON_FLAGS) . "\n\n");
        $idle = static function () use (&$lastWrite, $write): bool {
            return microtime(true) - $lastWrite >= 15 ? $write(": ping\n\n") : !connection_aborted();
        };

        $reply = '';
        $errMsg = null;
        try {
            $emit(['type' => 'start', 'conversationId' => $conversationId, 'agent' => $agent]);
            $observe = static function (array $e) use ($emit, &$reply, &$errMsg): bool {
                if ($e['type'] === 'done') {
                    $reply = (string) $e['content'];
                }
                if ($e['type'] === 'error') {
                    $errMsg = (string) $e['message'];
                }
                return $emit($e);
            };
            DeweeGatewayConnection::streamChat(
                $creds,
                $this->o['userIdPrefix'] . $visitorId,
                $agent,
                $sessionKey,
                $message,
                (int) $this->o['timeoutMs'],
                $observe,
                $idle,
            );
        } catch (Throwable $e) {
            $errMsg = $e->getMessage();
            $emit(['type' => 'error', 'message' => $errMsg, 'code' => 'gateway_error']);
        } finally {
            if (isset($this->o['onChat']) && is_callable($this->o['onChat'])) {
                try {
                    ($this->o['onChat'])(['visitorId' => $visitorId, 'agent' => $agent, 'message' => $message, 'reply' => $reply, 'error' => $errMsg]);
                } catch (Throwable) {
                    // observer errors are ignored
                }
            }
        }
    }

    private function handleHistory(): void
    {
        $visitorId = $this->visitorFromRequest();
        if ($visitorId === null) {
            $this->fail(401, 'Missing or expired visitor session', 'unauthorized');
            return;
        }
        [$creds, $isByo, $error] = $this->resolveCreds();
        if ($error !== null) {
            $this->fail(400, $error, 'bad_credentials');
            return;
        }
        if ($creds === null) {
            $this->fail(500, 'Gateway is not configured', 'not_configured');
            return;
        }
        $conversationId = $_GET['conversationId'] ?? '';
        if (!is_string($conversationId) || !preg_match(self::ID_RE, $conversationId)) {
            $this->fail(400, 'Invalid conversationId');
            return;
        }
        $requested = $_GET['agent'] ?? null;
        $agent = $this->pickAgent(is_string($requested) && $requested !== '' ? $requested : null, $creds, $isByo);
        if ($agent === null) {
            $this->fail(403, 'Agent not allowed', 'agent_not_allowed');
            return;
        }
        try {
            $messages = DeweeGatewayConnection::fetchHistory(
                $creds,
                $this->o['userIdPrefix'] . $visitorId,
                $agent,
                self::buildSessionKey($agent, "webchat-{$visitorId}-{$conversationId}"),
            );
        } catch (Throwable $e) {
            // A conversation that has not sent its first message yet does not exist on the gateway.
            if ($e instanceof DeweeGatewayError && $e->gatewayCode === 'NOT_FOUND') {
                $this->json(['messages' => []]);
                return;
            }
            $this->fail(502, $e->getMessage(), 'gateway_error');
            return;
        }
        $this->json(['messages' => $messages]);
    }

    // ---------------------------------------------------------------- credentials & agents

    /** @return array{0: array{url: string, token: string, tenantId?: string}|null, 1: bool, 2: string|null} */
    private function resolveCreds(): array
    {
        $url = self::header(self::HEADER_GATEWAY_URL);
        $token = self::header(self::HEADER_GATEWAY_TOKEN);
        if ($url !== null || $token !== null) {
            if ($this->byo === null) {
                return [null, true, 'Client credentials are disabled on this server'];
            }
            if ($url === null || $token === null) {
                return [null, true, 'Both gateway URL and token are required'];
            }
            $u = parse_url($url);
            $scheme = strtolower((string) ($u['scheme'] ?? ''));
            $host = strtolower((string) ($u['host'] ?? ''));
            if ($u === false || $host === '' || !in_array($scheme, ['http', 'https'], true) || isset($u['user']) || isset($u['pass'])) {
                return [null, true, 'Invalid gateway URL'];
            }
            // The server connects wherever the client points it, so internal hosts need an explicit allowlist entry.
            $allowed = $this->byo['allowedHosts'] ?? [];
            $listed = in_array($host, $allowed, true);
            if ($allowed && !$listed) {
                return [null, true, 'Gateway host not allowed'];
            }
            if (!$listed && (self::isInternalHost($host) || self::resolvesToInternal($host))) {
                return [null, true, 'Gateway host not allowed'];
            }
            if ($scheme !== 'https' && !($listed && $scheme === 'http')) {
                return [null, true, 'Gateway URL must use https'];
            }
            $defaultPort = $scheme === 'https' ? 443 : 80;
            $port = isset($u['port']) && $u['port'] !== $defaultPort ? ':' . $u['port'] : '';
            $path = rtrim((string) ($u['path'] ?? ''), '/');
            return [['url' => "{$scheme}://{$host}{$port}{$path}", 'token' => $token], true, null];
        }
        $gw = $this->o['gatewayUrl'] ?? null;
        $tk = $this->o['token'] ?? null;
        if (!is_string($gw) || $gw === '' || !is_string($tk) || $tk === '') {
            return [null, false, null];
        }
        $creds = ['url' => $gw, 'token' => $tk];
        if (!empty($this->o['tenantId'])) {
            $creds['tenantId'] = (string) $this->o['tenantId'];
        }
        return [$creds, false, null];
    }

    /**
     * @param array{url: string, token: string, tenantId?: string}|null $creds
     * @return list<array{id: string, name?: string}>
     */
    private function agentsFor(?array $creds, bool $isByo): array
    {
        if (($isByo || $this->wildcardAgents) && $creds !== null) {
            return self::listAgents($creds);
        }
        $missingNames = array_filter($this->staticAgents, static fn ($a) => !isset($a['name']));
        if ($creds !== null && $missingNames) {
            // Fill missing display names from the gateway; ids stay the allowlist.
            try {
                $all = self::listAgents($creds);
            } catch (Throwable) {
                return $this->staticAgents;
            }
            $names = array_column($all, 'name', 'id');
            return array_map(
                static fn ($a) => isset($a['name']) || !isset($names[$a['id']]) ? $a : $a + ['name' => $names[$a['id']]],
                $this->staticAgents,
            );
        }
        return $this->staticAgents;
    }

    /** @param array{url: string, token: string, tenantId?: string}|null $creds */
    private function pickAgent(?string $requested, ?array $creds, bool $isByo): ?string
    {
        if ($isByo || $this->wildcardAgents) {
            $a = $requested ?: ($this->o['defaultAgent'] ?? null) ?: ($this->agentsFor($creds, $isByo)[0]['id'] ?? null);
            return is_string($a) && preg_match(self::AGENT_RE, $a) ? $a : null;
        }
        $def = ($this->o['defaultAgent'] ?? null) ?: ($this->staticAgents[0]['id'] ?? null);
        if ($requested === null || $requested === '') {
            return $def;
        }
        foreach ($this->staticAgents as $a) {
            if ($a['id'] === $requested) {
                return $requested;
            }
        }
        return null;
    }

    /**
     * Lists active agents via GET {gateway}/v1/agents.
     *
     * @param array{url: string, token: string, tenantId?: string} $creds
     * @return list<array{id: string, name: string}>
     */
    public static function listAgents(array $creds): array
    {
        // Ownerless operator API keys must name a user; "system" sees every agent of the tenant.
        $headers = ['Authorization: Bearer ' . $creds['token'], 'X-GoClaw-User-Id: system', 'Accept: application/json'];
        if (!empty($creds['tenantId'])) {
            $headers[] = 'X-GoClaw-Tenant-Id: ' . $creds['tenantId'];
        }
        [$status, $raw] = self::httpRequest('GET', rtrim($creds['url'], '/') . '/v1/agents', $headers);
        if ($status < 200 || $status >= 300) {
            throw new DeweeGatewayError("Listing agents failed (HTTP {$status})", 'agents_failed');
        }
        $body = json_decode($raw, true);
        $out = [];
        foreach (is_array($body) && is_array($body['agents'] ?? null) ? $body['agents'] : [] as $a) {
            if (!is_array($a) || (!empty($a['status']) && $a['status'] !== 'active')) {
                continue;
            }
            $id = ($a['agent_key'] ?? null) ?: ($a['id'] ?? null);
            if (!is_scalar($id) || (string) $id === '') {
                continue;
            }
            $out[] = ['id' => (string) $id, 'name' => (string) (($a['display_name'] ?? null) ?: $id)];
        }
        return $out;
    }

    // ---------------------------------------------------------------- visitor tokens

    /** @param array{v: string, exp: int} $claims */
    public static function signVisitorToken(string $secret, array $claims): string
    {
        $body = self::b64url((string) json_encode(['v' => $claims['v'], 'exp' => $claims['exp']], self::JSON_FLAGS));
        return $body . '.' . self::b64url(hash_hmac('sha256', $body, $secret, true));
    }

    /** @return array{v: string, exp: int|float}|null */
    public static function verifyVisitorToken(string $secret, string $token): ?array
    {
        $parts = explode('.', $token);
        $body = $parts[0];
        $sig = $parts[1] ?? '';
        if ($body === '' || $sig === '') {
            return null;
        }
        $sigBytes = self::fromB64url($sig);
        if ($sigBytes === null || !hash_equals(hash_hmac('sha256', $body, $secret, true), $sigBytes)) {
            return null;
        }
        $json = self::fromB64url($body);
        $claims = $json === null ? null : json_decode($json, true);
        if (!is_array($claims) || !is_string($claims['v'] ?? null) || !preg_match(self::VISITOR_RE, $claims['v'])) {
            return null;
        }
        $exp = $claims['exp'] ?? null;
        if ((!is_int($exp) && !is_float($exp)) || $exp < self::nowMs()) {
            return null;
        }
        return ['v' => $claims['v'], 'exp' => $exp];
    }

    public static function randomId(int $bytes = 16): string
    {
        return self::b64url(random_bytes($bytes));
    }

    public static function buildSessionKey(string $agent, string $conversationId): string
    {
        return "agent:{$agent}:ws:direct:{$conversationId}";
    }

    private function visitorFromRequest(): ?string
    {
        $auth = self::header('authorization') ?? '';
        $token = str_starts_with($auth, 'Bearer ') ? substr($auth, 7) : '';
        return $token !== '' ? (self::verifyVisitorToken($this->secret, $token)['v'] ?? null) : null;
    }

    // ---------------------------------------------------------------- security helpers

    /**
     * Fixed-window limiter backed by small lock files in the temp dir.
     * Override with option 'rateLimit' => callable(string $key, string $bucket): bool, or false to disable.
     */
    private function rateLimit(string $key, string $bucket): bool
    {
        $custom = $this->o['rateLimit'] ?? null;
        if ($custom === false) {
            return true;
        }
        if (is_callable($custom)) {
            return (bool) $custom($key, $bucket);
        }
        [$max, $windowMs] = self::RATE_LIMITS[$bucket];
        $dir = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'dewee-webchat-rl';
        if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
            error_log('[dewee-webchat] Rate limiter storage unavailable; requests are not limited.');
            return true;
        }
        $fp = @fopen($dir . DIRECTORY_SEPARATOR . hash('sha256', "{$bucket}:{$key}"), 'c+');
        if ($fp === false) {
            error_log('[dewee-webchat] Rate limiter storage unavailable; requests are not limited.');
            return true;
        }
        $now = self::nowMs();
        try {
            flock($fp, LOCK_EX);
            $w = json_decode((string) stream_get_contents($fp), true);
            if (!is_array($w) || !is_int($w['start'] ?? null) || $now - $w['start'] >= $windowMs) {
                $w = ['start' => $now, 'count' => 1];
            } else {
                $w['count'] = (int) ($w['count'] ?? 0) + 1;
            }
            ftruncate($fp, 0);
            rewind($fp);
            fwrite($fp, (string) json_encode($w));
            fflush($fp);
        } finally {
            flock($fp, LOCK_UN);
            fclose($fp);
        }
        if (random_int(1, 200) === 1) {
            foreach (glob($dir . DIRECTORY_SEPARATOR . '*') ?: [] as $f) {
                if (@filemtime($f) < time() - 3600) {
                    @unlink($f);
                }
            }
        }
        return $w['count'] <= $max;
    }

    public static function verifyTurnstile(string $secret, string $response, ?string $ip = null): bool
    {
        $form = ['secret' => $secret, 'response' => $response];
        if ($ip !== null && $ip !== '' && $ip !== 'unknown') {
            $form['remoteip'] = $ip;
        }
        try {
            [$status, $raw] = self::httpRequest(
                'POST',
                'https://challenges.cloudflare.com/turnstile/v0/siteverify',
                ['Content-Type: application/x-www-form-urlencoded'],
                http_build_query($form),
            );
        } catch (Throwable) {
            return false;
        }
        $data = json_decode($raw, true);
        return $status === 200 && is_array($data) && ($data['success'] ?? null) === true;
    }

    /** Loopback, private, link-local and metadata addresses (plus bare/internal names). */
    public static function isInternalHost(string $host): bool
    {
        $h = preg_replace('/^\[|\]$/', '', strtolower($host)) ?? '';
        if ($h === 'localhost' || str_ends_with($h, '.localhost') || str_ends_with($h, '.internal') || str_ends_with($h, '.local')
            || (!str_contains($h, '.') && !str_contains($h, ':'))) {
            return true;
        }
        if (preg_match('/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/', $h, $m)) {
            [$a, $b] = [(int) $m[1], (int) $m[2]];
            return $a === 0 || $a === 10 || $a === 127 || ($a === 169 && $b === 254) || ($a === 172 && $b >= 16 && $b <= 31)
                || ($a === 192 && $b === 168) || ($a === 100 && $b >= 64 && $b <= 127);
        }
        return str_contains($h, ':') && ($h === '::1' || $h === '::' || str_starts_with($h, 'fc') || str_starts_with($h, 'fd')
            || str_starts_with($h, 'fe80') || str_starts_with($h, '::ffff:'));
    }

    /**
     * PHP's resolver accepts shorthand IPv4 forms (e.g. 0x7f.1) that URL parsers normalize, and DNS
     * names can point at private addresses, so also check what the host actually resolves to.
     */
    private static function resolvesToInternal(string $host): bool
    {
        $h = trim($host, '[]');
        if (filter_var($h, FILTER_VALIDATE_IP)) {
            return false; // literal IPs were already checked by isInternalHost
        }
        $ips = @gethostbynamel($h);
        if ($ips === false) {
            return false; // unresolvable: the connection will fail anyway
        }
        foreach ($ips as $ip) {
            if (self::isInternalHost($ip)) {
                return true;
            }
        }
        return false;
    }

    private function originAllowed(): bool
    {
        $origin = self::header('origin');
        if ($origin === null || $origin === self::requestOrigin()) {
            return true;
        }
        $allowed = $this->o['allowedOrigins'] ?? [];
        return $allowed === '*' || (is_array($allowed) && in_array($origin, $allowed, true));
    }

    /** @return array<string, string> */
    private function corsHeaders(): array
    {
        $origin = self::header('origin');
        if ($origin === null || !$this->originAllowed()) {
            return [];
        }
        return [
            'Access-Control-Allow-Origin' => $origin,
            'Access-Control-Allow-Methods' => 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers' => 'content-type, authorization, ' . self::HEADER_GATEWAY_URL . ', ' . self::HEADER_GATEWAY_TOKEN,
            'Access-Control-Max-Age' => '600',
            'Vary' => 'Origin',
        ];
    }

    private static function requestOrigin(): string
    {
        $https = (!empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off')
            || strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
        $scheme = $https ? 'https' : 'http';
        $host = strtolower((string) ($_SERVER['HTTP_HOST'] ?? ($_SERVER['SERVER_NAME'] ?? '')));
        $host = preg_replace($https ? '/:443$/' : '/:80$/', '', $host) ?? $host;
        return "{$scheme}://{$host}";
    }

    private function clientIp(): string
    {
        foreach (['cf-connecting-ip', 'x-real-ip'] as $h) {
            $v = self::header($h);
            if ($v !== null) {
                return $v;
            }
        }
        $xff = self::header('x-forwarded-for');
        if ($xff !== null && trim(explode(',', $xff)[0]) !== '') {
            return trim(explode(',', $xff)[0]);
        }
        return (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
    }

    // ---------------------------------------------------------------- HTTP plumbing

    private static function header(string $name): ?string
    {
        $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
        $v = $_SERVER[$key] ?? null;
        if ($v === null && $name === 'authorization') {
            $v = $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? null;
        }
        return is_string($v) && $v !== '' ? $v : null;
    }

    /** @return array<mixed>|null */
    private function readJsonBody(): ?array
    {
        $raw = file_get_contents('php://input');
        if (!is_string($raw) || $raw === '' || strlen($raw) > 1_000_000) {
            return null;
        }
        $data = json_decode($raw, true);
        return is_array($data) ? $data : null;
    }

    /** @param array<string, string> $headers */
    private function sendHeaders(array $headers): void
    {
        foreach ($headers as $k => $v) {
            header("{$k}: {$v}");
        }
    }

    private function json(mixed $body, int $status = 200): void
    {
        http_response_code($status);
        $this->sendHeaders(['Content-Type' => 'application/json; charset=utf-8', 'Cache-Control' => 'no-store'] + $this->corsHeaders());
        echo json_encode($body, self::JSON_FLAGS);
    }

    private function fail(int $status, string $message, string $code = 'bad_request'): void
    {
        $this->json(['error' => ['message' => $message, 'code' => $code]], $status);
    }

    private function beginEventStream(): void
    {
        @set_time_limit(0);
        ignore_user_abort(true); // keep running after a disconnect so the gateway run can be aborted
        @ini_set('zlib.output_compression', '0');
        @ini_set('output_buffering', '0');
        @ini_set('implicit_flush', '1');
        if (function_exists('apache_setenv')) {
            @apache_setenv('no-gzip', '1');
        }
        while (ob_get_level() > 0) {
            @ob_end_clean();
        }
        http_response_code(200);
        $this->sendHeaders([
            'Content-Type' => 'text/event-stream; charset=utf-8',
            'Cache-Control' => 'no-cache, no-transform',
            'X-Accel-Buffering' => 'no',
        ] + $this->corsHeaders());
        @flush();
    }

    /**
     * Minimal HTTP client on PHP streams (no cURL dependency). Redirects are not followed.
     *
     * @param list<string> $headers
     * @return array{0: int, 1: string}
     */
    private static function httpRequest(string $method, string $url, array $headers, ?string $body = null, float $timeout = 15.0): array
    {
        $ctx = stream_context_create([
            'http' => [
                'method' => $method,
                'header' => implode("\r\n", array_merge($headers, ['User-Agent: dewee-webchat-php/' . self::VERSION, 'Connection: close'])),
                'content' => $body ?? '',
                'timeout' => $timeout,
                'ignore_errors' => true,
                'follow_location' => 0,
            ],
            'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
        ]);
        $raw = @file_get_contents($url, false, $ctx);
        $respHeaders = function_exists('http_get_last_response_headers')
            ? (http_get_last_response_headers() ?? [])
            : ($http_response_header ?? []);
        if ($raw === false || !$respHeaders || !preg_match('#^HTTP/\S+\s+(\d{3})#', (string) $respHeaders[0], $m)) {
            $err = error_get_last()['message'] ?? 'request failed';
            throw new DeweeGatewayError('Gateway request failed: ' . preg_replace('/^.*?: /', '', $err), 'http_failed');
        }
        return [(int) $m[1], $raw];
    }

    // ---------------------------------------------------------------- small utilities

    public static function b64url(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }

    private static function fromB64url(string $s): ?string
    {
        $bin = base64_decode(strtr($s, '-_', '+/'), true);
        return $bin === false ? null : $bin;
    }

    private static function nowMs(): int
    {
        return (int) floor(microtime(true) * 1000);
    }

    /** Drops null values (JSON.stringify omits undefined). */
    public static function withoutNulls(array $a): array
    {
        return array_filter($a, static fn ($v) => $v !== null);
    }

    /** String.prototype.trim(): strips Unicode whitespace, not just ASCII. */
    private static function jsTrim(string $s): string
    {
        return preg_replace('/^[\s\p{Z}\x{FEFF}]+|[\s\p{Z}\x{FEFF}]+$/u', '', $s) ?? trim($s);
    }

    /** JavaScript string length (UTF-16 code units) without requiring mbstring. */
    public static function utf16Length(string $s): int
    {
        $chars = preg_match_all('/./su', $s);
        if ($chars === false) {
            return strlen($s);
        }
        return $chars + (int) preg_match_all('/[\x{10000}-\x{10FFFF}]/u', $s);
    }

    /** Mirrors clip() in gateway-client.ts: stringify non-strings, cap at $max UTF-16 units. */
    public static function clip(mixed $v, int $max = 4000): ?string
    {
        if ($v === null) {
            return null;
        }
        $s = is_string($v) ? $v : (string) json_encode($v, self::JSON_FLAGS);
        if (self::utf16Length($s) <= $max) {
            return $s;
        }
        $out = '';
        $units = 0;
        preg_match_all('/./su', $s, $m);
        foreach ($m[0] as $ch) {
            $w = strlen($ch) === 4 ? 2 : 1;
            if ($units + $w > $max) {
                break;
            }
            $out .= $ch;
            $units += $w;
        }
        return $out . '…';
    }
}

/**
 * One authenticated gateway connection (protocol v3). Short-lived: one per chat turn or lookup.
 */
final class DeweeGatewayConnection
{
    private int $seq = 0;

    private function __construct(private DeweeWebSocket $ws)
    {
    }

    /** @param array{url: string, token: string, tenantId?: string} $creds */
    public static function connect(array $creds, string $userId, float $timeout = 15.0): self
    {
        $conn = new self(DeweeWebSocket::open(self::wsUrl($creds['url']), $timeout));
        $params = ['token' => $creds['token'], 'user_id' => $userId];
        if (!empty($creds['tenantId'])) {
            $params['tenant_id'] = $creds['tenantId'];
        }
        try {
            $conn->call('connect', $params, $timeout);
        } catch (Throwable $e) {
            $conn->close();
            throw $e;
        }
        return $conn;
    }

    private static function wsUrl(string $base): string
    {
        $u = parse_url($base);
        if ($u === false || empty($u['host'])) {
            throw new DeweeGatewayError('Invalid gateway URL', 'bad_url');
        }
        $scheme = strtolower((string) ($u['scheme'] ?? 'https')) === 'http' ? 'ws' : 'wss';
        $port = isset($u['port']) ? ':' . $u['port'] : '';
        $query = isset($u['query']) ? '?' . $u['query'] : '';
        return "{$scheme}://{$u['host']}{$port}" . rtrim((string) ($u['path'] ?? ''), '/') . '/ws' . $query;
    }

    /** Sends a request frame and returns its id. */
    public function send(string $method, mixed $params): string
    {
        $id = 'r' . (++$this->seq);
        $this->ws->sendText((string) json_encode(['type' => 'req', 'id' => $id, 'method' => $method, 'params' => $params], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        return $id;
    }

    /** Sends a request and waits for its response, ignoring interleaved events. */
    public function call(string $method, mixed $params, float $timeout): mixed
    {
        $id = $this->send($method, $params);
        $deadline = microtime(true) + $timeout;
        while (true) {
            $remaining = $deadline - microtime(true);
            if ($remaining <= 0) {
                throw new DeweeGatewayError("{$method} timed out", 'timeout');
            }
            $frame = $this->next($remaining);
            if ($frame !== null && ($frame->type ?? null) === 'res' && ($frame->id ?? null) === $id) {
                return self::result($frame);
            }
        }
    }

    /** Next decoded JSON frame, or null when nothing arrived within $timeout seconds. */
    public function next(float $timeout): ?object
    {
        $raw = $this->ws->receive($timeout);
        if ($raw === null) {
            return null;
        }
        $frame = json_decode($raw);
        return $frame instanceof stdClass ? $frame : null;
    }

    private static function result(object $frame): mixed
    {
        if (!empty($frame->ok)) {
            return $frame->payload ?? null;
        }
        $err = isset($frame->error) && is_object($frame->error) ? $frame->error : new stdClass();
        throw new DeweeGatewayError(
            is_string($err->message ?? null) && $err->message !== '' ? $err->message : 'Gateway request failed',
            isset($err->code) && is_scalar($err->code) ? (string) $err->code : null,
        );
    }

    public function close(): void
    {
        $this->ws->close();
    }

    /**
     * Runs one chat turn, calling $emit for each normalized stream event until the run ends.
     * $emit and $idle return false when the visitor disconnected; the run is then aborted.
     *
     * @param array{url: string, token: string, tenantId?: string} $creds
     * @param callable(array<string, mixed>): bool $emit
     * @param callable(): bool $idle
     */
    public static function streamChat(array $creds, string $userId, string $agent, string $sessionKey, string $message, int $timeoutMs, callable $emit, callable $idle): void
    {
        $conn = self::connect($creds, $userId);
        $aborted = false;
        try {
            $id = $conn->send('chat.send', ['agentId' => $agent, 'sessionKey' => $sessionKey, 'message' => $message, 'stream' => true]);
            $deadline = microtime(true) + $timeoutMs / 1000;
            while (true) {
                $remaining = $deadline - microtime(true);
                if ($remaining <= 0) {
                    $emit(['type' => 'error', 'message' => 'chat.send timed out', 'code' => 'timeout']);
                    break;
                }
                try {
                    $frame = $conn->next(min(1.0, $remaining));
                } catch (DeweeGatewayError $e) {
                    $emit(['type' => 'error', 'message' => $e->getMessage(), 'code' => $e->gatewayCode]);
                    break;
                }
                if ($frame === null) {
                    if (!$idle()) {
                        $aborted = true;
                        break;
                    }
                    continue;
                }
                if (($frame->type ?? null) === 'res' && ($frame->id ?? null) === $id) {
                    try {
                        $res = self::result($frame);
                        $emit(['type' => 'done', 'content' => (string) (self::prop($res, 'content') ?? ''), 'usage' => self::prop($res, 'usage')]);
                    } catch (DeweeGatewayError $e) {
                        $emit(['type' => 'error', 'message' => $e->getMessage(), 'code' => $e->gatewayCode]);
                    }
                    break;
                }
                if (($frame->type ?? null) !== 'event' || ($frame->event ?? null) !== 'agent' || !isset($frame->payload) || !is_object($frame->payload)) {
                    continue;
                }
                [$event, $end] = self::mapAgentEvent($frame->payload, $sessionKey);
                if ($event !== null && !$emit($event)) {
                    $aborted = true;
                    break;
                }
                if ($end) {
                    break;
                }
                if (!$idle()) {
                    $aborted = true;
                    break;
                }
            }
            if ($aborted) {
                try {
                    $conn->call('chat.abort', ['sessionKey' => $sessionKey], 3.0);
                } catch (Throwable) {
                    // best effort: the visitor is gone either way
                }
            }
        } finally {
            $conn->close();
        }
    }

    /**
     * Maps one gateway "agent" event to a widget stream event.
     *
     * @return array{0: array<string, mixed>|null, 1: bool} [event, runEnded]
     */
    private static function mapAgentEvent(object $payload, string $sessionKey): array
    {
        $key = self::truthy($payload->visibleSessionKey ?? null) ? $payload->visibleSessionKey : ($payload->sessionKey ?? null);
        if (self::truthy($key) && $key !== $sessionKey && ($payload->runSessionKey ?? null) !== $sessionKey) {
            return [null, false];
        }
        $p = isset($payload->payload) && is_object($payload->payload) ? $payload->payload : new stdClass();
        $content = $p->content ?? null;
        return match ($payload->type ?? null) {
            // run.started is announced by the handler's own start event (with the conversation id)
            'thinking' => [self::truthy($content) ? ['type' => 'thinking', 'text' => (string) $content] : null, false],
            'chunk' => [self::truthy($content) ? ['type' => 'delta', 'text' => (string) $content] : null, false],
            'tool.call' => [[
                'type' => 'tool_call',
                'id' => (string) (($p->id ?? null) ?: ''),
                'name' => (string) (($p->name ?? null) ?: 'tool'),
                'arguments' => $p->arguments ?? null,
            ], false],
            'tool.result' => [[
                'type' => 'tool_result',
                'id' => (string) (($p->id ?? null) ?: ''),
                'name' => (string) (($p->name ?? null) ?: 'tool'),
                'isError' => self::truthy($p->is_error ?? null),
                'result' => DeweeWebchat::clip($p->result ?? $p->content ?? null),
            ], false],
            'run.failed' => [['type' => 'error', 'message' => (string) (($p->error ?? null) ?: (($p->message ?? null) ?: 'Agent run failed')), 'code' => 'run_failed'], true],
            'run.cancelled' => [['type' => 'error', 'message' => 'Run cancelled', 'code' => 'cancelled'], true],
            default => [null, false],
        };
    }

    /**
     * Fetches a session transcript and folds tool calls/results into assistant turns.
     *
     * @param array{url: string, token: string, tenantId?: string} $creds
     * @return list<array<string, mixed>>
     */
    public static function fetchHistory(array $creds, string $userId, string $agent, string $sessionKey): array
    {
        $conn = self::connect($creds, $userId);
        try {
            $res = $conn->call('chat.history', ['agentId' => $agent, 'sessionKey' => $sessionKey], 15.0);
            $messages = self::prop($res, 'messages');
            return self::foldHistory(is_array($messages) ? $messages : []);
        } finally {
            $conn->close();
        }
    }

    /**
     * Mirrors foldHistory() in gateway-client.ts. Messages may be objects (json_decode) or arrays.
     *
     * @param array<mixed> $raw
     * @return list<array<string, mixed>>
     */
    public static function foldHistory(array $raw): array
    {
        $out = [];
        $cur = null; // index into $out of the open assistant turn
        foreach ($raw as $m) {
            $role = self::prop($m, 'role');
            if ($role === 'user') {
                $cur = null;
                $out[] = DeweeWebchat::withoutNulls(['role' => 'user', 'content' => self::str(self::prop($m, 'content') ?? ''), 'createdAt' => self::prop($m, 'created_at')]);
            } elseif ($role === 'assistant') {
                if ($cur === null) {
                    $out[] = DeweeWebchat::withoutNulls(['role' => 'assistant', 'content' => '', 'createdAt' => self::prop($m, 'created_at')]);
                    $cur = array_key_last($out);
                }
                $thinking = self::prop($m, 'thinking');
                if (self::truthy($thinking)) {
                    $out[$cur]['thinking'] = (isset($out[$cur]['thinking']) && $out[$cur]['thinking'] !== '' ? $out[$cur]['thinking'] . "\n\n" : '') . self::str($thinking);
                }
                $content = self::prop($m, 'content');
                if (self::truthy($content)) {
                    $out[$cur]['content'] = $out[$cur]['content'] !== '' ? $out[$cur]['content'] . "\n\n" . self::str($content) : self::str($content);
                }
                $toolCalls = self::prop($m, 'tool_calls');
                foreach (is_array($toolCalls) ? $toolCalls : [] as $tc) {
                    $fn = self::prop($tc, 'function');
                    $out[$cur]['toolCalls'] ??= [];
                    $out[$cur]['toolCalls'][] = DeweeWebchat::withoutNulls([
                        'id' => self::prop($tc, 'id'),
                        'name' => self::prop($tc, 'name') ?? self::prop($fn, 'name') ?? 'tool',
                        'arguments' => self::prop($tc, 'arguments') ?? self::prop($fn, 'arguments'),
                        'status' => 'done',
                    ]);
                }
            } elseif ($role === 'tool' && $cur !== null && isset($out[$cur]['toolCalls'])) {
                $callId = self::prop($m, 'tool_call_id');
                foreach ($out[$cur]['toolCalls'] as $i => $tc) {
                    if (($tc['id'] ?? null) === $callId) {
                        $result = DeweeWebchat::clip(self::prop($m, 'content'));
                        if ($result !== null) {
                            $out[$cur]['toolCalls'][$i]['result'] = $result;
                        }
                        if (self::truthy(self::prop($m, 'is_error'))) {
                            $out[$cur]['toolCalls'][$i]['isError'] = true;
                            $out[$cur]['toolCalls'][$i]['status'] = 'error';
                        }
                        break;
                    }
                }
            }
        }
        return array_values(array_filter(
            $out,
            static fn ($m) => $m['role'] === 'user' || $m['content'] !== '' || !empty($m['toolCalls']),
        ));
    }

    private static function prop(mixed $v, string $key): mixed
    {
        if (is_object($v)) {
            return $v->{$key} ?? null;
        }
        return is_array($v) ? ($v[$key] ?? null) : null;
    }

    /** JavaScript truthiness for decoded JSON values. */
    private static function truthy(mixed $v): bool
    {
        return !($v === null || $v === false || $v === '' || $v === 0 || $v === 0.0);
    }

    private static function str(mixed $v): string
    {
        return is_string($v) ? $v : (is_scalar($v) ? (is_bool($v) ? ($v ? 'true' : 'false') : (string) $v) : (string) json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }
}

/**
 * Minimal RFC 6455 client: TLS via ssl://, masked client frames, text messages, fragmentation,
 * ping/pong and close. Blocking reads with per-call timeouts.
 */
final class DeweeWebSocket
{
    private const MAX_MESSAGE = 16 * 1024 * 1024;

    private string $buf = '';
    private bool $closed = false;
    private ?int $fragOpcode = null;
    private string $fragData = '';

    /** @param resource $sock */
    private function __construct(private $sock)
    {
    }

    public static function open(string $url, float $timeout): self
    {
        $u = parse_url($url);
        $scheme = strtolower((string) ($u['scheme'] ?? ''));
        if ($u === false || empty($u['host']) || !in_array($scheme, ['ws', 'wss'], true)) {
            throw new DeweeGatewayError('Invalid WebSocket URL', 'bad_url');
        }
        $host = (string) $u['host'];
        $tls = $scheme === 'wss';
        $port = (int) ($u['port'] ?? ($tls ? 443 : 80));
        $path = ($u['path'] ?? '/') . (isset($u['query']) ? '?' . $u['query'] : '');
        $ctx = stream_context_create(['ssl' => [
            'verify_peer' => true,
            'verify_peer_name' => true,
            'peer_name' => trim($host, '[]'),
            'SNI_enabled' => true,
        ]]);
        $deadline = microtime(true) + $timeout;
        $sock = @stream_socket_client(($tls ? 'ssl://' : 'tcp://') . "{$host}:{$port}", $errno, $errstr, $timeout, STREAM_CLIENT_CONNECT, $ctx);
        if ($sock === false) {
            throw new DeweeGatewayError('Gateway connection failed' . ($errstr ? ": {$errstr}" : ''), 'connect_failed');
        }
        $ws = new self($sock);
        $key = base64_encode(random_bytes(16));
        $defaultPort = $tls ? 443 : 80;
        $hostHeader = $host . ($port !== $defaultPort ? ":{$port}" : '');
        $ws->write("GET {$path} HTTP/1.1\r\nHost: {$hostHeader}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            . "Sec-WebSocket-Key: {$key}\r\nSec-WebSocket-Version: 13\r\nUser-Agent: dewee-webchat-php/" . DeweeWebchat::VERSION . "\r\n\r\n");

        while (($end = strpos($ws->buf, "\r\n\r\n")) === false) {
            if (strlen($ws->buf) > 16384 || !$ws->fill($deadline)) {
                $ws->abortSocket();
                throw new DeweeGatewayError('Gateway connection timed out', 'timeout');
            }
        }
        $head = substr($ws->buf, 0, $end);
        $ws->buf = (string) substr($ws->buf, $end + 4);
        $lines = explode("\r\n", $head);
        if (!preg_match('#^HTTP/1\.[01] (\d{3})#', $lines[0], $m) || $m[1] !== '101') {
            $ws->abortSocket();
            throw new DeweeGatewayError('Gateway refused WebSocket upgrade (HTTP ' . ($m[1] ?? '?') . ')', 'upgrade_failed');
        }
        $accept = null;
        foreach (array_slice($lines, 1) as $line) {
            [$name, $value] = array_pad(explode(':', $line, 2), 2, '');
            if (strtolower(trim($name)) === 'sec-websocket-accept') {
                $accept = trim($value);
            }
        }
        if ($accept !== base64_encode(sha1($key . '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', true))) {
            $ws->abortSocket();
            throw new DeweeGatewayError('Gateway returned an invalid WebSocket handshake', 'upgrade_failed');
        }
        return $ws;
    }

    public function sendText(string $data): void
    {
        $this->sendFrame(0x1, $data);
    }

    /**
     * Returns the next complete text/binary message, or null if none arrived within $timeout seconds.
     * Answers pings transparently. Throws DeweeGatewayError once the connection is closed.
     */
    public function receive(float $timeout): ?string
    {
        $deadline = microtime(true) + $timeout;
        while (true) {
            if ($this->closed) {
                throw new DeweeGatewayError('Gateway connection closed', 'closed');
            }
            $frame = $this->parseFrame();
            if ($frame === null) {
                if (!$this->fill($deadline)) {
                    return null;
                }
                continue;
            }
            [$fin, $op, $payload] = $frame;
            switch ($op) {
                case 0x9: // ping
                    $this->sendFrame(0xA, $payload);
                    break;
                case 0xA: // pong
                    break;
                case 0x8: // close
                    $this->close(1000);
                    throw new DeweeGatewayError('Gateway connection closed', 'closed');
                case 0x0: // continuation
                    if ($this->fragOpcode === null) {
                        throw $this->protocolError('Unexpected continuation frame');
                    }
                    $this->fragData .= $payload;
                    if (strlen($this->fragData) > self::MAX_MESSAGE) {
                        throw $this->protocolError('Gateway message too large');
                    }
                    if ($fin) {
                        $msg = $this->fragData;
                        $this->fragOpcode = null;
                        $this->fragData = '';
                        return $msg;
                    }
                    break;
                case 0x1:
                case 0x2:
                    if ($this->fragOpcode !== null) {
                        throw $this->protocolError('Interleaved data frame during fragmented message');
                    }
                    if ($fin) {
                        return $payload;
                    }
                    $this->fragOpcode = $op;
                    $this->fragData = $payload;
                    break;
                default:
                    throw $this->protocolError('Unknown WebSocket opcode ' . $op);
            }
        }
    }

    public function close(int $code = 1000, string $reason = 'done'): void
    {
        if ($this->closed) {
            return;
        }
        $this->closed = true;
        try {
            $this->sendFrame(0x8, pack('n', $code) . $reason, true);
        } catch (Throwable) {
            // peer already gone
        }
        $this->abortSocket();
    }

    private function protocolError(string $message): DeweeGatewayError
    {
        $this->close(1002, 'protocol error');
        return new DeweeGatewayError($message, 'socket_error');
    }

    private function abortSocket(): void
    {
        $this->closed = true;
        if (is_resource($this->sock)) {
            @fclose($this->sock);
        }
    }

    /** @return array{0: bool, 1: int, 2: string}|null */
    private function parseFrame(): ?array
    {
        $len = strlen($this->buf);
        if ($len < 2) {
            return null;
        }
        $b0 = ord($this->buf[0]);
        $b1 = ord($this->buf[1]);
        $size = $b1 & 0x7F;
        $offset = 2;
        if ($size === 126) {
            if ($len < 4) {
                return null;
            }
            $size = unpack('n', substr($this->buf, 2, 2))[1];
            $offset = 4;
        } elseif ($size === 127) {
            if ($len < 10) {
                return null;
            }
            $size = unpack('J', substr($this->buf, 2, 8))[1];
            $offset = 10;
        }
        if ($size < 0 || $size > self::MAX_MESSAGE) {
            throw $this->protocolError('Gateway message too large');
        }
        $masked = ($b1 & 0x80) !== 0;
        $maskKey = '';
        if ($masked) {
            if ($len < $offset + 4) {
                return null;
            }
            $maskKey = substr($this->buf, $offset, 4);
            $offset += 4;
        }
        if ($len < $offset + $size) {
            return null;
        }
        $payload = (string) substr($this->buf, $offset, $size);
        $this->buf = (string) substr($this->buf, $offset + $size);
        if ($masked && $size > 0) {
            $payload ^= substr(str_repeat($maskKey, intdiv($size + 3, 4)), 0, $size);
        }
        return [($b0 & 0x80) !== 0, $b0 & 0x0F, $payload];
    }

    private function sendFrame(int $opcode, string $payload, bool $force = false): void
    {
        if ($this->closed && !$force) {
            throw new DeweeGatewayError('Gateway connection closed', 'closed');
        }
        $n = strlen($payload);
        $head = chr(0x80 | $opcode);
        if ($n < 126) {
            $head .= chr(0x80 | $n);
        } elseif ($n < 65536) {
            $head .= chr(0x80 | 126) . pack('n', $n);
        } else {
            $head .= chr(0x80 | 127) . pack('J', $n);
        }
        $mask = random_bytes(4);
        $masked = $n > 0 ? $payload ^ substr(str_repeat($mask, intdiv($n + 3, 4)), 0, $n) : '';
        $this->write($head . $mask . $masked);
    }

    private function write(string $data): void
    {
        stream_set_timeout($this->sock, 15);
        $total = strlen($data);
        $done = 0;
        while ($done < $total) {
            $w = @fwrite($this->sock, substr($data, $done));
            if ($w === false || $w === 0) {
                $this->abortSocket();
                throw new DeweeGatewayError('Gateway connection error', 'socket_error');
            }
            $done += $w;
        }
    }

    /** Reads more bytes into the buffer. Returns false when the deadline passed without data. */
    private function fill(float $deadline): bool
    {
        while (true) {
            $remaining = $deadline - microtime(true);
            if ($remaining <= 0) {
                return false;
            }
            $sec = (int) floor($remaining);
            stream_set_timeout($this->sock, $sec, (int) (($remaining - $sec) * 1_000_000));
            $chunk = @fread($this->sock, 65536);
            if (is_string($chunk) && $chunk !== '') {
                $this->buf .= $chunk;
                return true;
            }
            $meta = stream_get_meta_data($this->sock);
            if (!empty($meta['timed_out'])) {
                return false;
            }
            if ($chunk === false || feof($this->sock)) {
                $this->abortSocket();
                throw new DeweeGatewayError('Gateway connection closed', 'closed');
            }
        }
    }
}
