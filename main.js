// Электрон-оболочка: запускает Python-сервер (server.py) и показывает интерфейс в окне.
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');

let py = null;
let win = null;
let pyErr = '';

const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const ping = port => new Promise(res => {
  http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 800 }, r => { r.resume(); res(r.statusCode === 200); })
    .on('error', () => res(false)).on('timeout', function () { this.destroy(); res(false); });
});

function trySpawn(cmd, port) {
  return new Promise(resolve => {
    let p, iv, to, done = false;
    const finish = ok => {
      if (done) return;
      done = true; clearInterval(iv); clearTimeout(to);
      if (!ok && p) { try { p.kill(); } catch {} }
      resolve(ok ? p : null);
    };
    try { p = spawn(cmd, [path.join(__dirname, 'server.py'), '--no-browser', '--port', String(port)], { cwd: __dirname, windowsHide: true }); }
    catch { return resolve(null); }
    p.once('error', () => finish(false));
    p.once('exit', () => finish(false));
    p.stdout.on('data', d => process.stdout.write(d));
    p.stderr.on('data', d => { pyErr += d; process.stderr.write(d); });
    iv = setInterval(async () => { if (await ping(port)) finish(true); }, 250);
    to = setTimeout(() => finish(false), 12000);
  });
}

async function startPython(port) {
  const cmds = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
  for (const c of cmds) { const p = await trySpawn(c, port); if (p) return p; }
  throw new Error('Не удалось запустить Python. Установите Python 3.9+ (с галочкой Add to PATH) и перезапустите Electro.\n\n' + pyErr.slice(-500));
}

async function boot() {
  try {
    const port = await freePort();
    py = await startPython(port);
    win = new BrowserWindow({ width: 1040, height: 660, minWidth: 820, minHeight: 560, show: false, frame: false, transparent: true, backgroundColor: '#00000000', autoHideMenuBar: true, title: 'Electro',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true } });
    win.once('ready-to-show', () => win.show());
    win.loadURL(`http://127.0.0.1:${port}/`);
  } catch (e) {
    dialog.showErrorBox('Electro', e.message);
    app.quit();
  }
}

ipcMain.on('win:close', () => app.quit());
ipcMain.on('win:min', () => { if (win) win.minimize(); });

app.whenReady().then(boot);
app.on('before-quit', () => { if (py) py.kill(); });
app.on('window-all-closed', () => app.quit());
