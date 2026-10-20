jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))
jest.mock('../config/config', () => ({ claude: { apiVersion: '2023-06-01' } }), {
  virtual: true
})
jest.mock('../src/utils/proxyHelper', () => ({}))
jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({}))
jest.mock('../src/utils/sessionHelper', () => ({}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/services/claudeCodeHeadersService', () => ({
  getAccountHeaders: jest.fn(async () => ({}))
}))
jest.mock('../src/validators/clients/claudeCodeValidator', () => ({
  includesClaudeCodeSystemPrompt: jest.fn(() => true)
}))
jest.mock('../src/services/requestIdentityService', () => ({
  transform: jest.fn(({ body, headers }) => ({
    body: { ...body, metadata: { ...body.metadata, user_id: 'legacy-identity' } },
    headers
  }))
}))
jest.mock('../src/utils/testPayloadHelper', () => ({}))
jest.mock('../src/services/userMessageQueueService', () => ({}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({}))
jest.mock('../src/utils/performanceOptimizer', () => ({ getPricingData: jest.fn(() => null) }))

const originalFlag = process.env.CLAUDE_NATIVE_PASSTHROUGH
const account = { useUnifiedUserAgent: 'false', useUnifiedClientId: 'false' }
const makeBody = (stream = true) => ({
  model: 'claude-opus-4-6',
  max_tokens: 64000,
  stream,
  system: [
    { type: 'text', text: 'x-anthropic-billing-header: offline-fixture' },
    {
      type: 'text',
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
      cache_control: { type: 'ephemeral', ttl: '1h' }
    }
  ],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [],
  metadata: {
    user_id: JSON.stringify({
      device_id: 'a'.repeat(64),
      account_uuid: '',
      session_id: '00000000-0000-4000-8000-000000000001'
    })
  },
  output_config: { effort: 'high' },
  future_client_field: { preserve: true }
})
const makeHeaders = () => ({
  'user-agent': 'claude-cli/2.1.300 (external, cli)',
  'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,custom-client-beta',
  'x-claude-code-session-id': '00000000-0000-4000-8000-000000000001',
  'x-client-request-id': 'offline-request',
  'accept-encoding': 'gzip, deflate, br, zstd',
  authorization: 'Bearer downstream-fixture',
  'x-api-key': 'downstream-fixture',
  cookie: 'private-fixture',
  'x-forwarded-for': '192.0.2.1',
  'cf-connecting-ip': '192.0.2.1',
  'content-encoding': 'gzip',
  host: 'relay.example.test'
})

function loadRelay(flag) {
  if (flag === undefined) {
    delete process.env.CLAUDE_NATIVE_PASSTHROUGH
  } else {
    process.env.CLAUDE_NATIVE_PASSTHROUGH = flag
  }
  return require('../src/services/relay/claudeRelayService')
}

beforeEach(() => jest.resetModules())
afterEach(() => {
  jest.clearAllMocks()
  if (originalFlag === undefined) {
    delete process.env.CLAUDE_NATIVE_PASSTHROUGH
  } else {
    process.env.CLAUDE_NATIVE_PASSTHROUGH = originalFlag
  }
})

it.each([true, false])('preserves the complete native body for stream=%s', async (stream) => {
  const relay = loadRelay('true')
  const body = makeBody(stream)
  const before = JSON.parse(JSON.stringify(body))
  const processed = relay._processRequestBody(body, account, true)
  const prepared = await relay._prepareRequestHeadersAndPayload(
    processed,
    makeHeaders(),
    'offline-account',
    'upstream-fixture',
    { account, requestOptions: { isRealClaudeCodeRequest: true }, isStream: stream }
  )

  expect(processed).not.toBe(body)
  expect(prepared.requestPayload).toEqual(before)
  expect(JSON.parse(prepared.bodyString)).toEqual(before)
  expect(body).toEqual(before)
  expect(require('../src/services/requestIdentityService').transform).not.toHaveBeenCalled()
})

it('preserves native headers while replacing authentication and transport framing', async () => {
  const relay = loadRelay('true')
  const headers = makeHeaders()
  const prepared = await relay._prepareRequestHeadersAndPayload(
    makeBody(),
    headers,
    'offline-account',
    'upstream-fixture',
    { account, requestOptions: { isRealClaudeCodeRequest: true } }
  )

  expect(prepared.headers['x-claude-code-session-id']).toBe(headers['x-claude-code-session-id'])
  expect(prepared.headers['x-client-request-id']).toBe('offline-request')
  expect(prepared.headers['anthropic-beta']).toBe(headers['anthropic-beta'])
  expect(prepared.headers['User-Agent']).toBe(headers['user-agent'])
  expect(prepared.headers.authorization).toBe('Bearer upstream-fixture')
  expect(prepared.headers.host).toBe('api.anthropic.com')
  expect(prepared.headers['content-length']).toBe(String(Buffer.byteLength(prepared.bodyString)))
  expect(prepared.headers['accept-encoding']).toBe('identity')
  for (const name of [
    'x-api-key',
    'cookie',
    'x-forwarded-for',
    'cf-connecting-ip',
    'content-encoding'
  ]) {
    expect(prepared.headers).not.toHaveProperty(name)
  }
})

it('only appends the required OAuth beta when the client omitted it', async () => {
  const relay = loadRelay('true')
  const headers = { ...makeHeaders(), 'anthropic-beta': 'custom-beta,claude-code-20250219' }
  const prepared = await relay._prepareRequestHeadersAndPayload(
    makeBody(),
    headers,
    'offline-account',
    'upstream-fixture',
    { account, requestOptions: { isRealClaudeCodeRequest: true } }
  )
  expect(prepared.headers['anthropic-beta']).toBe(
    'custom-beta,claude-code-20250219,oauth-2025-04-20'
  )
})

it('does not apply the account-wide identity overrides to native requests', async () => {
  const relay = loadRelay('true')
  const capture = jest.spyOn(relay, 'captureAndGetUnifiedUserAgent')
  const overridingAccount = {
    useUnifiedUserAgent: 'true',
    useUnifiedClientId: 'true',
    unifiedClientId: 'override'
  }
  const body = makeBody()
  const processed = relay._processRequestBody(body, overridingAccount, true)
  const prepared = await relay._prepareRequestHeadersAndPayload(
    processed,
    makeHeaders(),
    'offline-account',
    'upstream-fixture',
    { account: overridingAccount, requestOptions: { isRealClaudeCodeRequest: true } }
  )
  expect(prepared.requestPayload.metadata).toEqual(body.metadata)
  expect(capture).not.toHaveBeenCalled()
})

it.each([undefined, 'false'])('keeps legacy behavior when the flag is %s', async (flag) => {
  const relay = loadRelay(flag)
  const processed = relay._processRequestBody(makeBody(), account, true)
  expect(processed.system).toHaveLength(1)
  expect(processed.system[0].cache_control).not.toHaveProperty('ttl')
  const prepared = await relay._prepareRequestHeadersAndPayload(
    processed,
    makeHeaders(),
    'offline-account',
    'upstream-fixture',
    { account, requestOptions: { isRealClaudeCodeRequest: true } }
  )
  expect(prepared.headers).not.toHaveProperty('x-claude-code-session-id')
  expect(require('../src/services/requestIdentityService').transform).toHaveBeenCalledTimes(1)
})

it('keeps third-party client transformations when native forwarding is enabled', async () => {
  const relay = loadRelay('true')
  const processed = relay._processRequestBody(makeBody(), account, false)
  const prepared = await relay._prepareRequestHeadersAndPayload(
    processed,
    { ...makeHeaders(), 'user-agent': 'third-party-client' },
    'offline-account',
    'upstream-fixture',
    { account, requestOptions: { isRealClaudeCodeRequest: false } }
  )
  expect(prepared.headers).not.toHaveProperty('x-claude-code-session-id')
  expect(require('../src/services/requestIdentityService').transform).toHaveBeenCalledTimes(1)
})
