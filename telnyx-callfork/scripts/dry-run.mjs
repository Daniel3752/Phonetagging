#!/usr/bin/env node
/**
 * Offline TeXML renderer — prints the exact XML each branch would return,
 * without Telnyx, without wrangler, and without burning a single minute.
 *
 * Usage:  node scripts/dry-run.mjs
 *
 * Same output as hitting the deployed worker with ?dry=1, e.g.
 *   curl 'https://…/voice/dial-status?dry=1&DialCallStatus=no-answer'
 */

import {
  handleInbound,
  handleDialStatus,
  handleQueueAction,
  handleDequeueStatus,
  queueWaitTexml,
  config,
} from '../src/index.js';

const env = {
  TELNYX_US_DID: '+15550001111',
  SIP_URI: 'sip:mycredential@sip.telnyx.com',
  FLIP_NUMBER: '+972500000000',
  IPHONE_HOT_NUMBER: '+972500000001',
  RING_TIMEOUT: '15',
  MAX_HOLD_SECONDS: '60',
  QUEUE_NAME: 'parked',
  HOLD_MUSIC_URL: '',
};

const cfg = config(env);
const base = 'https://telnyx-callfork.example.workers.dev';
const urls = {
  inbound: `${base}/voice/inbound`,
  dialStatus: `${base}/voice/dial-status`,
  queueWait: `${base}/voice/queue-wait`,
  queueAction: `${base}/voice/queue-action`,
  dequeueStatus: `${base}/voice/dequeue-status`,
};

const cases = [
  ['1. Stranger calls the US DID -> fork both handsets', () =>
    handleInbound(cfg, { From: '+14155550123', To: env.TELNYX_US_DID }, urls)],

  ['2. Fork unanswered (I rejected on the flip) -> park', () =>
    handleDialStatus(cfg, { DialCallStatus: 'no-answer' }, urls)],

  ['2b. Fork answered -> release, never re-dial', () =>
    handleDialStatus(cfg, { DialCallStatus: 'completed' }, urls)],

  ['3. Hold music / hold loop document', () =>
    ({ branch: 'queue-wait', xml: queueWaitTexml(cfg) })],

  ['4. I call back from the flip -> bridge into the parked caller', () =>
    handleInbound(cfg, { From: env.FLIP_NUMBER, To: env.TELNYX_US_DID }, urls)],

  ['4b. Israeli national format ANI (0500000000) still matches whitelist', () =>
    handleInbound(cfg, { From: '0500000000', To: env.TELNYX_US_DID }, urls)],

  ['5. I called back but nothing was parked', () =>
    handleDequeueStatus(cfg, { DialCallStatus: 'no-answer' }, urls)],

  ['6. Caller aged out of the queue -> voicemail prompt + hangup', () =>
    handleQueueAction(cfg, { QueueResult: 'hangup' }, urls)],

  ['6b. Caller was bridged and the conversation ended', () =>
    handleQueueAction(cfg, { QueueResult: 'bridged' }, urls)],
];

for (const [title, run] of cases) {
  const { branch, xml } = run();
  console.log(`\n=== ${title}\n--- branch: ${branch}`);
  console.log(xml);
}
console.log('');
