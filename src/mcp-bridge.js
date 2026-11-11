#!/usr/bin/env node
/**
 * Tool bridge. The Claude and Codex CLIs launch this as a stdio MCP server; it forwards
 * tool listings and calls to the running QuietQuest daemon over loopback HTTP.
 *
 * Environment: QQ_URL, QQ_TOKEN, QQ_ROLE (pm | worker), QQ_AGENT_ID (workers only).
 */
import http from 'node:http';

const { QQ_URL, QQ_TOKEN, QQ_ROLE = 'pm', QQ_AGENT_ID = '' } = process.env;

// node:http rather than fetch: an approval can wait on a human for longer than fetch's header timeout.
function daemon(method, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const request = http.request(
      new URL(route, QQ_URL),
      {
        method,
        headers: {
          'x-qq-token': QQ_TOKEN,
          ...(payload && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => {
          try {
            const json = JSON.parse(text);
            if (response.statusCode >= 400) reject(new Error(json.error || `HTTP ${response.statusCode}`));
            else resolve(json);
          } catch {
            reject(new Error(`Unreadable response from QuietQuest (HTTP ${response.statusCode})`));
          }
        });
      },
    );
    request.on('error', (error) => reject(new Error(`QuietQuest daemon unreachable: ${error.message}`)));
    request.end(payload);
  });
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

async function handle(message) {
  const { id, method, params } = message;
  // Notifications carry no id and expect no reply.
  if (id === undefined) return;
  try {
    switch (method) {
      case 'initialize':
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'quietquest', version: '0.1.0' },
          },
        });
        break;
      case 'ping':
        send({ jsonrpc: '2.0', id, result: {} });
        break;
      case 'tools/list': {
        const { tools } = await daemon('GET', `/internal/tools?role=${encodeURIComponent(QQ_ROLE)}`);
        send({ jsonrpc: '2.0', id, result: { tools } });
        break;
      }
      case 'tools/call': {
        const result = await daemon('POST', '/internal/call', {
          role: QQ_ROLE,
          agentId: QQ_AGENT_ID,
          name: params?.name,
          arguments: params?.arguments ?? {},
        });
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: result.text }], isError: Boolean(result.isError) },
        });
        break;
      }
      default:
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (error) {
    if (method === 'tools/call') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: error.message }], isError: true } });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: error.message } });
    }
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // Ignore lines that are not JSON-RPC.
    }
  }
});
process.stdin.on('end', () => process.exit(0));
