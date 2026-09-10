// Generates the slash-command table for README.md from the command registry —
// single source of truth (§3.17): registry → /help → autocomplete → README.
import { listCommands } from '../dist/agent/commands.js';

const rows = listCommands().map(
  (c) => `| \`/${c.name}${c.hint ? ` ${c.hint}` : ''}\` | ${c.help} |`,
);
console.log('| Perintah | Fungsi |\n| --- | --- |');
console.log(rows.join('\n'));
