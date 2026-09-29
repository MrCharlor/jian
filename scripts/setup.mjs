import { randomBytes } from 'node:crypto';
import { appendFile, chmod, readFile, writeFile } from 'node:fs/promises';

const masterKeys = JSON.stringify({ v1: randomBytes(32).toString('base64') });
const password = randomBytes(24).toString('hex');
const contents = `JIAN_API_TOKEN=${randomBytes(32).toString('hex')}
JIAN_ACTIVE_KEY_ID=v1
JIAN_MASTER_KEYS='${masterKeys}'
POSTGRES_PASSWORD=${password}
DATABASE_URL=postgres://jian:${password}@localhost:5432/jian
HOST=127.0.0.1
PORT=4310
JIAN_ROLE=all
JIAN_TIME_ZONE=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
ANTHROPIC_API_TOKEN=
GEMINI_API_TOKEN=
`;
try {
  await writeFile(new URL('../.env', import.meta.url), contents, { mode: 0o600, flag: 'wx' });
  console.log(
    '.env criado com credenciais locais. Configure a chave do provider antes de executar agentes.',
  );
} catch (error) {
  if (error.code === 'EEXIST') {
    const path = new URL('../.env', import.meta.url);
    const existing = await readFile(path, 'utf8');
    if (!/^\s*(?:export\s+)?JIAN_MASTER_KEYS\s*=/m.test(existing)) {
      await appendFile(path, `\nJIAN_ACTIVE_KEY_ID=v1\nJIAN_MASTER_KEYS='${masterKeys}'\n`);
      await chmod(path, 0o600);
      console.log('Cofre configurado em .env; configurações existentes preservadas.');
    } else console.log('.env já existe; nenhuma alteração feita.');
  } else throw error;
}
