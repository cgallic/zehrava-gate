const fs = require('fs');

function parseEnvFile(path) {
  const env = {};
  if (!fs.existsSync(path)) return env;
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return env;
}

const envVars = parseEnvFile('/opt/zehrava-gate/.env');

module.exports = {
  apps: [{
    name: 'zehrava-gate',
    script: '/opt/zehrava-gate/src/index.js',
    cwd: '/opt/zehrava-gate',
    env: {
      ...envVars,
      DATA_DIR: '/opt/zehrava-gate/data',
      POLICY_DIR: '/opt/zehrava-gate/policies',
      PORT: '3001',
    }
  }]
};
