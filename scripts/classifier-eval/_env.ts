/**
 * Dependency-free .env loader for the eval scripts. Reads backend/.env into
 * process.env (does not override anything already set). Avoids relying on the
 * `dotenv` package being hoisted by pnpm — importing this for its side effect
 * is enough: `import './_env';` at the top of a script.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const envPath = path.join(__dirname, '../../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
