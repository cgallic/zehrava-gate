#!/usr/bin/env node
/**
 * Courier File Bus — MCP Server
 * Exposes filebus_put, filebus_get, filebus_share, filebus_revoke, filebus_audit_search, filebus_manifest_verify
 */

const readline = require('readline');

const FILE_BUS_ENDPOINT = process.env.FILE_BUS_ENDPOINT || 'http://localhost:3001';
const AGENT_API_KEY = process.env.FILE_BUS_API_KEY || '';

const rl = readline.createInterface({ input: process.stdin });

async function callApi(method, path, body) {
  const { default: fetch } = await import('node-fetch');
  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${AGENT_API_KEY}`, 'Content-Type': 'application/json' }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${FILE_BUS_ENDPOINT}${path}`, opts);
  return res.json();
}

async function uploadFile(name, content, mimeType = 'text/plain') {
  const { default: fetch } = await import('node-fetch');
  const FormData = (await import('form-data')).default;
  const form = new FormData();
  form.append('file', Buffer.from(content), { filename: name, contentType: mimeType });
  const res = await fetch(`${FILE_BUS_ENDPOINT}/files.put`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${AGENT_API_KEY}`, ...form.getHeaders() },
    body: form
  });
  return res.json();
}

const TOOLS = [
  {
    name: 'filebus_put',
    description: 'Upload a file to the agent file bus. Returns file_id, content_hash, and manifest_id.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Name of the file' },
        content: { type: 'string', description: 'File content (text)' },
        mime_type: { type: 'string', description: 'MIME type (default: text/plain)' }
      },
      required: ['filename', 'content']
    }
  },
  {
    name: 'filebus_get',
    description: 'Get metadata for a file you own or have been granted access to.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'File ID to retrieve' }
      },
      required: ['file_id']
    }
  },
  {
    name: 'filebus_share',
    description: 'Share a file with another agent. Specify recipient agent ID, permissions, and optional expiry.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'File ID to share' },
        recipient_id: { type: 'string', description: 'Agent ID of the recipient' },
        permissions: {
          type: 'array',
          items: { type: 'string', enum: ['read', 'download', 'reshare'] },
          description: 'Permissions to grant (default: read, download)'
        },
        expires_in_hours: { type: 'number', description: 'Hours until access expires (default: no expiry)' }
      },
      required: ['file_id', 'recipient_id']
    }
  },
  {
    name: 'filebus_revoke',
    description: 'Revoke a previously granted share. Future access attempts will be denied immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        grant_id: { type: 'string', description: 'Grant ID to revoke' }
      },
      required: ['grant_id']
    }
  },
  {
    name: 'filebus_download',
    description: 'Get a time-limited download token for a file you have access to.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'File ID to download' },
        ttl_minutes: { type: 'number', description: 'Token TTL in minutes (default: 5)' }
      },
      required: ['file_id']
    }
  },
  {
    name: 'filebus_audit_search',
    description: 'Search the immutable audit log for file activity.',
    inputSchema: {
      type: 'object',
      properties: {
        target_id: { type: 'string', description: 'Filter by file_id or grant_id' },
        action: { type: 'string', description: 'Filter by action (file.upload, file.share, file.download, share.revoke)' },
        limit: { type: 'number', description: 'Max results (default: 20)' }
      }
    }
  },
  {
    name: 'filebus_manifest_verify',
    description: 'Verify a file manifest signature to confirm authenticity and integrity.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'File ID to get manifest for' }
      },
      required: ['file_id']
    }
  }
];

async function handleTool(name, args) {
  try {
    switch (name) {
      case 'filebus_put': {
        const result = await uploadFile(args.filename, args.content, args.mime_type);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'filebus_get': {
        const result = await callApi('GET', `/files/${args.file_id}`);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'filebus_share': {
        const body = {
          recipient_id: args.recipient_id,
          permissions: args.permissions || ['read', 'download']
        };
        if (args.expires_in_hours) body.expires_in_ms = args.expires_in_hours * 3600000;
        const result = await callApi('POST', `/files/${args.file_id}/share`, body);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'filebus_revoke': {
        const result = await callApi('POST', `/shares/${args.grant_id}/revoke`);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'filebus_download': {
        const ttl_ms = (args.ttl_minutes || 5) * 60000;
        const result = await callApi('POST', `/files/${args.file_id}/download-token`, { ttl_ms });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ...result,
              download_url: `${FILE_BUS_ENDPOINT}/files/${args.file_id}/content?token=${result.token}`
            }, null, 2)
          }]
        };
      }

      case 'filebus_audit_search': {
        const params = new URLSearchParams();
        if (args.target_id) params.set('target_id', args.target_id);
        if (args.action) params.set('action', args.action);
        if (args.limit) params.set('limit', args.limit);
        const result = await callApi('GET', `/audit?${params}`);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'filebus_manifest_verify': {
        const manifest = await callApi('GET', `/files/${args.file_id}/manifest`);
        if (!manifest.manifest) return { content: [{ type: 'text', text: 'No manifest found for this file' }] };
        const m = manifest.manifest;
        const verify = await callApi('POST', '/manifest/verify', {
          manifest_id: m.manifest_id,
          file_id: m.file_id,
          sender_id: m.sender_id,
          recipient_id: m.recipient_id,
          content_hash: m.content_hash,
          timestamp: m.created_at,
          expires_at: m.expires_at,
          signature: m.signature
        });
        return { content: [{ type: 'text', text: JSON.stringify({ manifest: m, verification: verify }, null, 2) }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
}

function respond(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function error(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
}

rl.on('line', async (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }

  const { id, method, params } = req;

  if (method === 'initialize') {
    return respond(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'courier-file-bus', version: '0.1.0' }
    });
  }

  if (method === 'tools/list') {
    return respond(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const result = await handleTool(params.name, params.arguments || {});
    return respond(id, result);
  }

  error(id, -32601, `Method not found: ${method}`);
});

process.stderr.write('Courier File Bus MCP server ready\n');
