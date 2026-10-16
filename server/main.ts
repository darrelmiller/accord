import { startCompanion } from './http.js';

const port = process.env.ACCORD_PORT ? Number(process.env.ACCORD_PORT) : 0;
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('ACCORD_PORT must be 0–65535.');
const { origin, token } = await startCompanion(port);
console.log(`Accord is local only. Open this private launch URL in your browser:\n${origin}/#token=${token}`);
console.log('Select an existing Git repository root. No repository scripts or Git mutations are run. Ctrl+C stops the companion.');
