const { app } = require('electron');
console.log('app type:', typeof app);
if (app && app.whenReady) {
  app.whenReady().then(() => {
    console.log('SUCCESS - App Ready!');
    app.quit();
  });
} else {
  console.log('FAIL - app is:', app);
  process.exit(1);
}
