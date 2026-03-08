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
    script: '/opt/zehrava-gate/src/index.js',
    cwd: '/opt/zehrava-gate',
    env: {
      ...parseEnvFile('/opt/zehrava-gate/.env'),
      DATA_DIR: '/opt/zehrava-gate/data',
      POLICY_DIR: '/opt/zehrava-gate/policies',
      PORT: '3001',
      VAULT_CONFIG: '/opt/zehrava-gate/config/vault.yaml',
    }
  }]
};
