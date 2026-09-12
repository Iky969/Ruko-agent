#!/usr/bin/env bash
set -e

REPO="https://github.com/Iky969/Ruko-agent.git"
INSTALL_DIR="$HOME/.ruko-agent"
TAG="v1.0.0"

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

echo "Mengambil kode Ruko versi $TAG..."
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
