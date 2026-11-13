// Serves the viewer with the SQLite provider. Usage: node server.mjs [db-file]
// Then open http://localhost:5180, File > Open > Catalog.

import { createLogViewer } from '@kevinwang15/log-viewer';
import { createSqliteProvider } from './provider.mjs';

const viewer = createLogViewer({
  providers: [createSqliteProvider(process.argv[2] || 'logs.db')],
  streams: false,
});
const { url } = await viewer.listen(Number(process.env.PORT) || 5180);
console.log(`log viewer on ${url}`);
process.on('SIGINT', () => viewer.close().then(() => process.exit(0)));
