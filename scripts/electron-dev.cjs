/* Starts Electron against the Vite dev server once it is reachable (cross-platform). */
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const URL = 'http://localhost:5173';

function waitForPort(port, host = '127.0.0.1', timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect(port, host);
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error('Vite dev server did not start'));
        else setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

waitForPort(5173).then(() => {
  const electron = require('electron');
  const child = spawn(electron, [path.join(__dirname, '..')], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: URL },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
});
