import { mkdirSync, writeFileSync } from 'node:fs';
import { buildOpenApiDocument } from '../src/api/public/openapi.js';

// Regenerates docs/openapi/public-v1.json. A test compares it with the live document.
const target = new URL('../../../docs/openapi/public-v1.json', import.meta.url);
mkdirSync(new URL('./', target), { recursive: true });
writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log('written', target.pathname);
