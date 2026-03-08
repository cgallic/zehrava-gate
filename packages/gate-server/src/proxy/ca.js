'use strict';

/**
 * Gate V3 — Proxy Certificate Authority
 *
 * Generates a local CA certificate at startup.
 * Issues per-hostname certs signed by that CA on demand.
 * Caches certs in memory — only one per hostname, ever.
 *
 * To trust Gate's CA (required for browsers/curl -v, optional for agents):
 *   Install the CA cert at DATA_DIR/proxy-ca/ca.crt in your trust store.
 *   curl: --cacert /opt/zehrava-gate/data/proxy-ca/ca.crt
 *   Node.js agent: NODE_EXTRA_CA_CERTS=/opt/zehrava-gate/data/proxy-ca/ca.crt
 */

const forge = require('node-forge');
const fs = require('fs');
const path = require('path');

const CA_DIR = path.join(
  process.env.DATA_DIR || path.join(__dirname, '../../../data'),
  'proxy-ca'
);

let caCert = null;
let caKey = null;
const certCache = new Map(); // hostname → { cert: PEM, key: PEM }

function initCA() {
  fs.mkdirSync(CA_DIR, { recursive: true });

  const certPath = path.join(CA_DIR, 'ca.crt');
  const keyPath  = path.join(CA_DIR, 'ca.key');

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    caCert = forge.pki.certificateFromPem(fs.readFileSync(certPath, 'utf8'));
    caKey  = forge.pki.privateKeyFromPem(fs.readFileSync(keyPath,  'utf8'));
    console.log('[proxy:ca] Loaded existing CA cert from', certPath);
    return certPath;
  }

  console.log('[proxy:ca] Generating new CA certificate (one-time, ~2s)…');

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey    = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter  = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: 'commonName',       value: 'Zehrava Gate Proxy CA' },
    { name: 'organizationName', value: 'Zehrava Gate'          },
    { shortName: 'OU',          value: 'Proxy Intercept'       },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  caCert = cert;
  caKey  = keys.privateKey;

  fs.writeFileSync(certPath, forge.pki.certificateToPem(cert));
  fs.writeFileSync(keyPath,  forge.pki.privateKeyToPem(keys.privateKey));

  console.log('[proxy:ca] CA generated:', certPath);
  console.log('[proxy:ca] Trust this CA to avoid TLS warnings in agents:');
  console.log(`[proxy:ca]   curl: --cacert ${certPath}`);
  console.log(`[proxy:ca]   Node: NODE_EXTRA_CA_CERTS=${certPath}`);

  return certPath;
}

function getCertForHost(hostname) {
  if (certCache.has(hostname)) return certCache.get(hostname);
  if (!caCert || !caKey) throw new Error('[proxy:ca] CA not initialized — call initCA() first');

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey    = keys.publicKey;
  cert.serialNumber = Date.now().toString(16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter  = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  cert.setSubject([
    { name: 'commonName',       value: hostname         },
    { name: 'organizationName', value: 'Zehrava Gate'   },
  ]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(caKey, forge.md.sha256.create());

  const result = {
    cert: forge.pki.certificateToPem(cert),
    key:  forge.pki.privateKeyToPem(keys.privateKey),
  };
  certCache.set(hostname, result);
  return result;
}

function getCAPath() {
  return path.join(CA_DIR, 'ca.crt');
}

module.exports = { initCA, getCertForHost, getCAPath };
