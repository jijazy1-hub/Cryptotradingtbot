const fs = require('fs');
const path = require('path');

function saveSignals(signals, filename = 'signals.json') {
  const fullPath = path.resolve(process.cwd(), filename);
  fs.writeFileSync(fullPath, JSON.stringify(signals, null, 2));
}

module.exports = {
  saveSignals
};
