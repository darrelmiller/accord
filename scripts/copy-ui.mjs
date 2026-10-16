import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist/ui', { recursive: true });
await Promise.all(['index.html', 'styles.css'].map(name => copyFile(`ui/${name}`, `dist/ui/${name}`)));
