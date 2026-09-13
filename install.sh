#!/usr/bin/env bash
set -e

REPO="https://github.com/Iky969/Ruko-agent.git"
INSTALL_DIR="$HOME/.ruko-agent"
TAG="${RUKO_VERSION:-main}"

echo "== Ruko Agent Installer =="

# 1. Cek Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js tidak ditemukan. Pasang Node.js >= 18 terlebih dahulu."
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Error: Membutuhkan Node.js >= 18, terdeteksi $(node -v)"
  exit 1
fi

# 2. Cek Git
if ! command -v git >/dev/null 2>&1; then
  echo "Error: git tidak ditemukan. Pasang git terlebih dahulu."
  exit 1
fi

echo "Mengambil kode Ruko ($TAG)..."
rm -rf "$INSTALL_DIR"
git clone --depth 1 --branch "$TAG" "$REPO" "$INSTALL_DIR"

cd "$INSTALL_DIR"
echo "Memasang dependensi pembangunan..."
npm install

echo "Membangun distribusi (TypeScript -> ESM)..."
npm run build

echo "Memasang perintah global 'ruko'..."
npm install -g .

echo ""
echo "Instalasi selesai!"
echo "Masuk ke direktori proyek Anda lalu ketik: ruko"

# Pastikan dist index dan biner global diberi izin eksekusi
chmod +x dist/index.js 2>/dev/null || true

# Pasang secara global
npm install -g .

# Amankan izin biner global di Termux maupun Linux biasa
if [ -n "$PREFIX" ] && [ -f "$PREFIX/bin/ruko" ]; then
  chmod +x "$PREFIX/bin/ruko"
elif [ -f "/usr/local/bin/ruko" ]; then
  chmod +x "/usr/local/bin/ruko"
fi
