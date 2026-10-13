import 'dotenv/config';
import cron from 'node-cron';
import { runOnce } from './run.js';
import { log } from './util.js';

let running = false;

async function safeRun() {
  if (running) return log('Previous run still in progress - skipping');
  running = true;
  try {
    await runOnce();
    log('Run complete');
  } catch (err) {
    log('Run failed:', err);
    process.exitCode = 1;
  } finally {
    running = false;
  }
}

if (process.argv.includes('--once')) {
  await safeRun();
} else {
  const schedule = process.env.CRON_SCHEDULE || '0 7 * * *';
  log(`Mandate Matcher scheduled: "${schedule}" (${process.env.TZ || 'local time'})`);
  cron.schedule(schedule, safeRun, { timezone: process.env.TZ || undefined });
  await safeRun(); // run immediately on start
}
