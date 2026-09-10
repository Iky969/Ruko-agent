// Sync check: README slash-command table vs generated registry table.
import fs from 'node:fs';
import { listCommands } from '../dist/agent/commands.js';

const gen = listCommands();
const readme = fs.readFileSync('README.md', 'utf8');
const table = readme.split('### Slash Commands')[1].split('\n---')[0];
const mdNames = [...table.matchAll(/\/([a-z]+)[^`\n]*`\s*\|/g)].map((m) => m[1]);
const missing = gen.map((c) => c.name).filter((n) => !mdNames.includes(n));
const extra = mdNames.filter((n) => !gen.some((c) => c.name === n));

if (missing.length === 0 && extra.length === 0) {
  console.log('IN SYNC:', gen.length, 'commands');
} else {
  console.log('OUT OF SYNC — missing:', missing, 'extra:', extra);
  // Rewrite the table from the registry (single source of truth).
  const pipe = String.fromCharCode(124);
  const rows = gen.map((c) => {
    const usage = (c.hint ? `/${c.name} ${c.hint}` : `/${c.name}`).split(pipe).join('\\' + pipe);
    const help = c.help.split(pipe).join('\\' + pipe);
    return `| \`${usage}\` | ${help} |`;
  });
  const header = `| Perintah | Fungsi |\n| --- | --- |`;
  const newTable = `### Slash Commands\nRegistry tunggal di \`src/agent/commands.ts\` — setiap command mendeklarasikan \`name\`, \`aliases\`, \`help\`, \`hint\`; \`/help\`, menu \`/\`, dan tabel README dibangkitkan dari sumber yang sama (\`scripts/gen-commands-doc.mjs\`) sehingga tidak pernah tidak sinkron.\n\n${header}\n${rows.join('\n')}\n`;
  const start = readme.indexOf('### Slash Commands');
  const end = readme.indexOf('\n---', start);
  fs.writeFileSync('README.md', readme.slice(0, start) + newTable + readme.slice(end));
  console.log('table regenerated');
}
