/**
 * PM2 ecosystem config example.
 * Copy to ecosystem.config.js and adjust paths for your deployment.
 */
const fs = require('fs');
function parseEnvFile(p) {
  const env = {};
  if (!fs.existsSync(p)) return env;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return env;
}
module.exports = {
  apps: [{
    name: 'zehrava-gate',
    script: './src/index.js',
    cwd: '/path/to/your/gate-server',
    env: {
      ...parseEnvFile('.env'),
      DATA_DIR:    './data',
      POLICY_DIR:  './policies',
      PORT:        '3001',
      PROXY_PORT:  '4001',
      VAULT_CONFIG: './config/vault.yaml',
    }
  }]
};
