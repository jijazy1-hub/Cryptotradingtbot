require('dotenv').config();
const { runLiveCheck } = require('./src/services/liveService');

runLiveCheck().catch(error => {
  console.error('Live check failed:', error.message || error);
  process.exit(1);
});
