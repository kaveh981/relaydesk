import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { DemoReceiver } from './demo-receiver.js';
import { RelayStore } from './store.js';
import { httpTransport } from './transport.js';
import { DeliveryWorker } from './worker.js';

const config = loadConfig();
const store = new RelayStore(config.databasePath, config);
const app = await buildApp({
  store,
  adminKey: config.adminKey,
  webhookSecret: config.webhookSecret,
  deliverySecret: config.deliverySecret,
  demoMode: config.demoMode,
  logger: true,
  demoReceiver: new DemoReceiver(),
});
const worker = new DeliveryWorker(
  store,
  httpTransport({
    url: config.deliveryUrl,
    secret: config.deliverySecret,
    timeoutMs: config.timeoutMs,
  }),
  {
    leaseMs: config.leaseMs,
    onError: (error) => app.log.error({ err: error }, 'Delivery worker failed'),
  },
);
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  try {
    await worker.stop();
  } catch (error) {
    app.log.error({ err: error }, 'Worker shutdown failed');
    process.exitCode = 1;
  } finally {
    try {
      await app.close();
    } finally {
      store.close();
    }
  }
};
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
try {
  await app.listen({ host: config.host, port: config.port });
  worker.start();
} catch (error) {
  app.log.error(error);
  await shutdown();
  process.exitCode = 1;
}
