const db = require('../lib/db');

function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const apiKey = authHeader.slice(7);
  const agent = db.getAgentByKey(apiKey);

  if (!agent) {
    db.audit({ action: 'auth.failed', outcome: 'denied', details: { reason: 'invalid_key' } });
    return res.status(401).json({ error: 'Invalid API key' });
  }

  req.agent = agent;
  next();
}

module.exports = { authenticate };
