require('dotenv').config();
const cron = require('node-cron');
const { runLiveCheck } = require('./src/services/liveService');

const schedule = process.env.CRON_SCHEDULE || '0 * * * *';

async function safeRun() {
  try {
    await runLiveCheck();
  } catch (error) {
    // Keep the scheduler alive if one run fails
    console.error('Live check failed:', error.message || error);
  }
}

async function startScheduler() {
  if (!cron.validate(schedule)) throw new Error(`Invalid CRON_SCHEDULE: ${schedule}`);
  console.log(`Starting live signal scheduler: ${schedule}`);
  await safeRun();

  cron.schedule(schedule, async () => {
    console.log('Running scheduled live signal check...');
    await safeRun();
  });
}

startScheduler().catch(error => {
  console.error('Scheduler failed:', error.message || error);
  process.exit(1);
});
