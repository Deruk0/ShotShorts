const cp = require('child_process');

const env = { ...process.env };
// Remove the global environment variable that forces Electron to run as plain Node
delete env.ELECTRON_RUN_AS_NODE;

const child = cp.spawn(require('electron'), ['.'], {
  stdio: 'inherit',
  env,
  windowsHide: false
});

child.on('exit', (code) => {
  process.exit(code || 0);
});
