const db = require('../lib/db');
const { hashApiKey } = require('../lib/crypto');

function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const apiKey = authHeader.slice(7);
  const keyHash = hashApiKey(apiKey);

  const agent = db.prepare('SELECT * FROM agents WHERE api_key_hash = ?').get(keyHash);
  if (!agent) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  req.agent = agent;
  next();
}

module.exports = { authenticate };
