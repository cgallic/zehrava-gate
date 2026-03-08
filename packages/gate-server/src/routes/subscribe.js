const express = require('express');
const https = require('https');
const router = express.Router();

router.options('/subscribe', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

router.post('/subscribe', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ success: false, message: 'Valid email required' });
  }

  const LOOPS_KEY = process.env.LOOPS_API_KEY;
  if (!LOOPS_KEY) return res.status(500).json({ success: false });

  const payload = JSON.stringify({ email, userGroup: 'zehrava-gate-waitlist', source: 'zehrava.com' });

  const apiReq = https.request({
    hostname: 'app.loops.so',
    path: '/api/v1/contacts/create',
    method: 'POST',
    headers: { 'Authorization': `Bearer ${LOOPS_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
  }, (apiRes) => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => {
      try { res.json({ success: JSON.parse(data).success || false }); }
      catch { res.json({ success: false }); }
    });
  });
  apiReq.on('error', () => res.json({ success: false }));
  apiReq.write(payload);
  apiReq.end();
});

module.exports = router;
