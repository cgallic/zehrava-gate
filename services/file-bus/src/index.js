require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('./lib/db');
const { generateApiKey, generateDownloadToken, hashBuffer, signManifest, verifyManifest } = require('./lib/crypto');
const { authenticate } = require('./middleware/auth');

const app = express();
const PORT = process.env.FILE_BUS_PORT || 3001;

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../data/uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json());

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB limit

// ── Health ───────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'file-bus', version: '0.1.0', timestamp: Date.now() });
});

// ── Agent Registration ────────────────────────────────────────

app.post('/agents/register', (req, res) => {
  try {
    const { name, metadata } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const agent_id = 'agt_' + uuidv4().replace(/-/g, '').slice(0, 16);
    const api_key = generateApiKey();

    const agent = db.registerAgent({ agent_id, name, api_key, metadata });
    db.audit({ actor_id: agent_id, action: 'agent.register', target_id: agent_id, target_type: 'agent' });

    res.status(201).json({ agent_id, name, api_key, message: 'Store api_key securely — not shown again' });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Agent name already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/agents/:agent_id', authenticate, (req, res) => {
  const agent = db.getAgent(req.params.agent_id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const { api_key, ...safe } = agent;
  res.json(safe);
});

// ── File Upload ───────────────────────────────────────────────

app.post('/files.put', authenticate, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const file_id = 'file_' + uuidv4().replace(/-/g, '').slice(0, 20);
    const contentHash = hashBuffer(req.file.buffer);
    const filename = `${file_id}_${req.file.originalname}`;
    const storagePath = path.join(UPLOAD_DIR, filename);

    fs.writeFileSync(storagePath, req.file.buffer);

    const file = db.createFile({
      file_id,
      uploader_id: req.agent.agent_id,
      original_name: req.file.originalname,
      storage_path: storagePath,
      content_hash: contentHash,
      size_bytes: req.file.size,
      mime_type: req.file.mimetype,
      metadata: req.body.metadata ? JSON.parse(req.body.metadata) : {}
    });

    // Create upload manifest
    const manifest_id = 'mfst_' + uuidv4().replace(/-/g, '').slice(0, 16);
    const manifestPayload = { manifest_id, file_id, sender_id: req.agent.agent_id, content_hash: contentHash, timestamp: Date.now() };
    const signature = signManifest(manifestPayload);
    db.createManifest({ manifest_id, file_id, sender_id: req.agent.agent_id, content_hash: contentHash, signature });

    db.audit({ actor_id: req.agent.agent_id, action: 'file.upload', target_id: file_id, target_type: 'file', details: { size: req.file.size, hash: contentHash } });

    res.status(201).json({ file_id, content_hash: contentHash, size_bytes: req.file.size, manifest_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── File Metadata ─────────────────────────────────────────────

app.get('/files/:file_id', authenticate, (req, res) => {
  const file = db.getFile(req.params.file_id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  // Owner or valid grant required
  const isOwner = file.uploader_id === req.agent.agent_id;
  const grant = !isOwner ? db.getActiveGrant(req.params.file_id, req.agent.agent_id) : null;

  if (!isOwner && !grant) {
    db.audit({ actor_id: req.agent.agent_id, action: 'file.access', target_id: req.params.file_id, target_type: 'file', outcome: 'denied', details: { reason: 'no_grant' } });
    return res.status(403).json({ error: 'Access denied' });
  }

  db.audit({ actor_id: req.agent.agent_id, action: 'file.metadata', target_id: req.params.file_id, target_type: 'file' });
  const { storage_path, ...safe } = file;
  res.json(safe);
});

// ── Download Token ────────────────────────────────────────────

app.post('/files/:file_id/download-token', authenticate, (req, res) => {
  try {
    const file = db.getFile(req.params.file_id);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const isOwner = file.uploader_id === req.agent.agent_id;
    const grant = !isOwner ? db.getActiveGrant(req.params.file_id, req.agent.agent_id) : null;

    if (!isOwner && !grant) {
      db.audit({ actor_id: req.agent.agent_id, action: 'file.download_token', target_id: req.params.file_id, target_type: 'file', outcome: 'denied' });
      return res.status(403).json({ error: 'Access denied' });
    }

    const token = generateDownloadToken();
    const ttl_ms = req.body.ttl_ms || 300000; // 5 min default
    const dt = db.createDownloadToken({ token, file_id: file.file_id, agent_id: req.agent.agent_id, grant_id: grant?.grant_id, ttl_ms });

    db.audit({ actor_id: req.agent.agent_id, action: 'file.download_token_issued', target_id: file.file_id, target_type: 'file' });
    res.json({ token, expires_at: dt.expires_at, ttl_ms });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── File Download ─────────────────────────────────────────────

app.get('/files/:file_id/content', (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(401).json({ error: 'Download token required' });

    const dt = db.consumeDownloadToken(token);
    if (!dt || dt.file_id !== req.params.file_id) {
      return res.status(401).json({ error: 'Invalid or expired download token' });
    }

    const file = db.getFile(req.params.file_id);
    if (!file) return res.status(404).json({ error: 'File not found' });

    db.audit({ actor_id: dt.agent_id, action: 'file.download', target_id: file.file_id, target_type: 'file', details: { size: file.size_bytes } });

    res.setHeader('Content-Disposition', `attachment; filename="${file.original_name}"`);
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('X-Content-Hash', file.content_hash);
    res.sendFile(file.storage_path);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Share Grants ──────────────────────────────────────────────

app.post('/files/:file_id/share', authenticate, (req, res) => {
  try {
    const file = db.getFile(req.params.file_id);
    if (!file) return res.status(404).json({ error: 'File not found' });

    if (file.uploader_id !== req.agent.agent_id) {
      return res.status(403).json({ error: 'Only the file owner can share' });
    }

    const { recipient_id, permissions, expires_in_ms } = req.body;
    if (!recipient_id) return res.status(400).json({ error: 'recipient_id required' });

    const recipient = db.getAgent(recipient_id);
    if (!recipient) return res.status(404).json({ error: 'Recipient agent not found' });

    const grant_id = 'grnt_' + uuidv4().replace(/-/g, '').slice(0, 16);
    const expires_at = expires_in_ms ? Date.now() + expires_in_ms : null;
    const grant = db.createGrant({
      grant_id, file_id: file.file_id,
      sender_id: req.agent.agent_id,
      recipient_id, permissions: permissions || ['read', 'download'],
      expires_at
    });

    // Create share manifest
    const manifest_id = 'mfst_' + uuidv4().replace(/-/g, '').slice(0, 16);
    const manifestPayload = {
      manifest_id, file_id: file.file_id, grant_id,
      sender_id: req.agent.agent_id, recipient_id,
      content_hash: file.content_hash,
      timestamp: Date.now(), expires_at
    };
    const signature = signManifest(manifestPayload);
    db.createManifest({ manifest_id, file_id: file.file_id, grant_id, sender_id: req.agent.agent_id, recipient_id, content_hash: file.content_hash, signature, expires_at });

    db.audit({ actor_id: req.agent.agent_id, action: 'file.share', target_id: file.file_id, target_type: 'file', details: { recipient_id, grant_id, expires_at } });

    res.status(201).json({ grant_id, manifest_id, file_id: file.file_id, recipient_id, permissions: grant.permissions, expires_at });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/shares/:grant_id/revoke', authenticate, (req, res) => {
  try {
    const grant = db.getGrant(req.params.grant_id);
    if (!grant) return res.status(404).json({ error: 'Grant not found' });
    if (grant.sender_id !== req.agent.agent_id) return res.status(403).json({ error: 'Only the sender can revoke' });
    if (grant.revoked_at) return res.status(409).json({ error: 'Grant already revoked' });

    db.revokeGrant(grant.grant_id);
    db.audit({ actor_id: req.agent.agent_id, action: 'share.revoke', target_id: grant.grant_id, target_type: 'grant', details: { file_id: grant.file_id, recipient_id: grant.recipient_id } });

    res.json({ grant_id: grant.grant_id, status: 'revoked' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/files/:file_id/shares', authenticate, (req, res) => {
  const file = db.getFile(req.params.file_id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  if (file.uploader_id !== req.agent.agent_id) return res.status(403).json({ error: 'Access denied' });
  res.json({ file_id: req.params.file_id, grants: db.getFileGrants(req.params.file_id) });
});

// ── Manifest ──────────────────────────────────────────────────

app.get('/files/:file_id/manifest', authenticate, (req, res) => {
  const file = db.getFile(req.params.file_id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  const isOwner = file.uploader_id === req.agent.agent_id;
  const grant = !isOwner ? db.getActiveGrant(req.params.file_id, req.agent.agent_id) : null;
  if (!isOwner && !grant) return res.status(403).json({ error: 'Access denied' });

  const manifest = db.getFileManifest(req.params.file_id);
  res.json({ manifest });
});

app.post('/manifest/verify', (req, res) => {
  try {
    const { manifest_id, file_id, sender_id, recipient_id, content_hash, timestamp, expires_at, signature } = req.body;
    const payload = { manifest_id, file_id, sender_id, recipient_id, content_hash, timestamp, expires_at };
    const valid = verifyManifest(payload, signature);
    const expired = expires_at && Date.now() > expires_at;
    res.json({ valid: valid && !expired, signature_valid: valid, expired: !!expired });
  } catch (err) {
    res.status(400).json({ error: 'Invalid manifest payload' });
  }
});

// ── Audit ─────────────────────────────────────────────────────

app.get('/audit', authenticate, (req, res) => {
  const events = db.getAuditLog({
    actor_id: req.query.actor_id,
    target_id: req.query.target_id,
    action: req.query.action,
    limit: parseInt(req.query.limit) || 50
  });
  res.json({ events, count: events.length });
});

// ── Start ─────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Courier (File Bus) API on port ${PORT}`);
  console.log(`Storage: ${UPLOAD_DIR}`);
});

process.on('SIGINT', () => { db.close(); process.exit(0); });
