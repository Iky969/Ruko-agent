const readline = require("node:readline");
const out = process.stdout;

if (!out.isTTY || (out.columns || 80) < 24) {
  console.error("Gunakan terminal dengan lebar minimal 24 kolom.");
  process.exit(1);
}

const RESET = "\x1b[0m";
const paint = (text, code) => `\x1b[${code}m${text}${RESET}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const THINK_TIME = 7000;
const SPEED = 100;
const TEXT = "Thinking...";

let timer;
let animating = false;

function clear() {
  readline.cursorTo(out, 0);
  readline.clearLine(out, 0);
}

function restore() {
  out.write(RESET + "\x1b[?25h");
}

function thinking() {
  return new Promise(resolve => {
    const width = Math.min(38, out.columns - 1);
    const textX = Math.floor((width - TEXT.length) / 2);
    const started = Date.now();

    let x = width - 1;
    let frame = 0;
    animating = true;

    function render() {
      const cells = Array(width).fill(" ");

      function draw(text, position, color) {
        [...text].forEach((char, offset) => {
          const column = position + offset;
          if (column >= 0 && column < width) {
            cells[column] = paint(char, color);
          }
        });
      }

      // Huruf di belakang Pac-Man sudah dimakan.
      [...TEXT].forEach((char, index) => {
        const position = textX + index;
        if (position < x) draw(char, position, 36);
      });

      // Hantu mengejar dari sisi kanan.
      const ghost = Math.floor(frame / 2) % 2 ? "(oo)" : "(OO)";
      draw(ghost, x + 4, 96);
      draw(ghost, x + 10, 95);

      // Mulut menghadap kiri.
      draw(frame % 2 ? ">" : "O", x, 93);

      clear();
      out.write(cells.join(""));

      const finishedEating = x <= textX;
      const answerReady = Date.now() - started >= THINK_TIME;

      if (finishedEating && answerReady) {
        clearInterval(timer);
        timer = undefined;
        animating = false;
        clear();
        resolve();
        return;
      }

      x--;
      frame++;

      // Belum siap: keluar layar, lalu tulisan muncul lagi.
      if (x < -14) x = width - 1;
    }

    timer = setInterval(render, SPEED);
    render();
  });
}

process.once("SIGINT", () => {
  clearInterval(timer);
  if (animating) clear();
  restore();
  out.write("\n");
  process.exit(0);
});

async function main() {
  console.log("Demo: Pac-Man makan Thinking... lalu jawaban muncul.\n");
  out.write("\x1b[?25l");

  try {
    await thinking();

    // Streaming dimulai di baris bekas animasi.
    out.write(paint("AI > ", 92));

    const answer =
      "Halo! Thinking-nya sudah habis dimakan Pac-Man.\n" +
      "Sekarang jawaban muncul secara bertahap, tanpa menumpuk animasi.\n" +
      "Kalau respons belum siap, tulisan Thinking... akan muncul lagi.";

    for (const char of answer) {
      out.write(char);
      await sleep(char === "\n" ? 250 : 28);
    }

    out.write("\n");
  } finally {
    clearInterval(timer);
    restore();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

