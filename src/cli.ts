import { startServer } from './server.js';
import { formatTraffic } from './logging.js';

async function main() {
  if (process.argv.length > 2) {
    if (['--help', '-h'].includes(process.argv[2]!)) {
      console.log('mbus: local MCP message bus\n\nRun npm start. No token is required.\nMBUS_PORT defaults to 7331.\nMBUS_DB defaults to .mbus/history.sqlite; use :memory: for temporary history.');
      return;
    }
    throw new Error('Unknown argument. Use --help.');
  }
  const port = Number(process.env.MBUS_PORT ?? '7331');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MBUS_PORT must be an integer from 1 to 65535.');
  const server = await startServer({
    port, databasePath: process.env.MBUS_DB,
    bus: { onEvent: entry => console.log(formatTraffic(entry)) },
  });
  console.log(`mbus listening at ${server.url} (history: ${server.databasePath}; Ctrl+C to stop)`);
  console.log(`Traffic viewer: ${server.viewerUrl}`);
  const stop = () => { void server.close().catch(error => { console.error(error); process.exitCode = 1; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
