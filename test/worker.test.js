import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
const env = { EVERFLOW_API_KEY: 'test-everflow-secret', MCP_AUTH_TOKEN: 'test-connector-secret' };
function request(body, token = env.MCP_AUTH_TOKEN) {
  return new Request('https://worker.example/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
const rpc = (method, params = {}) => ({ jsonrpc: '2.0', id: 1, method, params });
test('health is public but reports no credentials or network data', async () => {
  const response = await worker.fetch(new Request('https://worker.example/health'), {});
  assert.equal(response.status, 200);
  assert.ok(!(await response.text()).includes(env.EVERFLOW_API_KEY));
});
test('fails closed without configuration or valid authentication', async () => {
  assert.equal((await worker.fetch(request(rpc('initialize')), {})).status, 503);
  assert.equal((await worker.fetch(request(rpc('initialize'), 'wrong'), env)).status, 401);
});
test('initialization advertises tools and stateless protocol', async () => {
  const data = await (await worker.fetch(request(rpc('initialize', { protocolVersion: '2025-06-18' })), env)).json();
  assert.equal(data.result.protocolVersion, '2025-06-18');
  assert.deepEqual(data.result.capabilities, { tools: {} });
});
test('write tools and arbitrary HTTP proxy requests never reach upstream', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Must not reach upstream'); };
  try {
    for (const name of ['update_offer', 'delete_conversion', 'create_conversion', 'http_request', '__proto__']) {
      const data = await (await worker.fetch(request(rpc('tools/call', { name, arguments: { url: 'https://evil.example' } })), env)).json();
      assert.equal(data.error.code, -32602);
    }
  } finally { globalThis.fetch = original; }
});
test('link generation validates arguments and defaults to redirect without following it', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.eflow.team/v1/networks/tracking/offers/clicks');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.is_redirect_link, true);
    assert.equal(body.sub1, '{{ad.id}}');
    return Response.json({ url: 'https://tracking.example/offer/partner/?sub1=%7B%7Bad.id%7D%7D' });
  };
  try {
    const good = await (await worker.fetch(request(rpc('tools/call', { name: 'generate_offer_tracking_link', arguments: { network_offer_id: 914, network_affiliate_id: 995, sub1: '{{ad.id}}' } })), env)).json();
    assert.ok(!good.result.isError);
    for (const args of [{ network_offer_id: '../delete', network_affiliate_id: 995 }, { network_offer_id: 914, network_affiliate_id: 995, url: 'https://evil.example' }]) {
      const bad = await (await worker.fetch(request(rpc('tools/call', { name: 'generate_offer_tracking_link', arguments: args })), env)).json();
      assert.equal(bad.result.isError, true);
    }
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
test('upstream discovery performs handshake, preserves session and filters future write tools', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://mcp.eflow.team');
    const body = JSON.parse(options.body);
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } }, { headers: { 'mcp-session-id': 'mock-session' } });
    assert.equal(options.headers['Mcp-Session-Id'], 'mock-session');
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'get_offer', inputSchema: { type: 'object' } }, { name: 'delete_offer', inputSchema: { type: 'object' } }] } });
  };
  try {
    const data = await (await worker.fetch(request(rpc('tools/list')), env)).json();
    assert.deepEqual(data.result.tools.map(t => t.name), ['get_offer', 'generate_offer_tracking_link']);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});
test('streaming upstream responses work for initialization and tools calls', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result = body.method === 'initialize' ? { protocolVersion: '2025-03-26' } : { content: [{ type: 'text', text: 'offer result' }] };
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const data = await (await worker.fetch(request(rpc('tools/call', { name: 'get_offer', arguments: { offer_id: 914 } })), env)).json();
    assert.equal(data.result.content[0].text, 'offer result');
  } finally { globalThis.fetch = original; }
});
