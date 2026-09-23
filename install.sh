#!/usr/bin/env bash
set -e

REPO="https://github.com/Iky969/Ruko-agent.git"
INSTALL_DIR="$HOME/.ruko-agent"
PINNED_COMMIT_SHA="5b029be14510fd0ac4a1c7cc47e46d30d4cb9de2" # v1.7.7 release
TAG="${RUKO_VERSION:-v1.7.7}"
TARGET_SHA="${RUKO_COMMIT_SHA:-$PINNED_COMMIT_SHA}"

# Parse args
FORCE=0
for arg in "$@"; do
  if [ "$arg" = "--force" ]; then
    FORCE=1
  fi
done

echo "== Ruko Agent Installer =="

# Path validation
if [[ "$INSTALL_DIR" == *".."* ]] || [[ "$INSTALL_DIR" != "$HOME"* ]]; then
  echo "Error: Invalid INSTALL_DIR path: $INSTALL_DIR"
  exit 1
fi

# Mutable branch protection: prevent pointing to mutable branches without explicit override
if [ "$TAG" = "main" ] || [ "$TAG" = "master" ] || [ "$TAG" = "HEAD" ]; then
  if [ "${RUKO_ALLOW_MUTABLE:-0}" -ne 1 ]; then
    echo "Error: Menargetkan branch mutable ('$TAG') ditolak demi keamanan supply chain."
    echo "  Gunakan release tag immutable (misal: v1.7.7) atau commit SHA spesifik via RUKO_COMMIT_SHA."
    echo "  Jika Anda sengaja ingin menggunakan branch mutable untuk pengembangan, set RUKO_ALLOW_MUTABLE=1"
    exit 1
  fi
fi

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

TEMP_DIR=$(mktemp -d)
BACKUP_DIR=""
SWAPPED=0

cleanup() {
  local exit_code=$?
  if [ $exit_code -ne 0 ]; then
    echo "Instalasi gagal (exit code: $exit_code)!"
    if [ "$SWAPPED" -eq 1 ] && [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
      echo "Memulihkan instalasi sebelumnya (rollback)..."
      if [ -d "$INSTALL_DIR" ]; then
        mv "$INSTALL_DIR" "${INSTALL_DIR}.failed.$(date +%s)" 2>/dev/null || true
      fi
      mv "$BACKUP_DIR" "$INSTALL_DIR"
      echo "Rollback berhasil: instalasi lama telah dipulihkan."
    fi
  fi
  rm -rf "$TEMP_DIR" 2>/dev/null || true
  exit $exit_code
}

trap cleanup EXIT

echo "Mengambil kode Ruko ($TAG)..."
if [ -n "$TARGET_SHA" ] && [ "${RUKO_ALLOW_MUTABLE:-0}" -ne 1 ]; then
  git clone "$REPO" "$TEMP_DIR"
  (
    cd "$TEMP_DIR"
    git checkout "$TARGET_SHA"
  )
else
  git clone --depth 1 --branch "$TAG" "$REPO" "$TEMP_DIR"
fi

(
  cd "$TEMP_DIR"
  echo "Memasang dependensi pembangunan..."
  npm ci

  echo "Membangun distribusi (TypeScript -> ESM)..."
  npm run build
)

# Validasi hasil build sebelum menyentuh instalasi aktif
if [ ! -f "$TEMP_DIR/dist/index.js" ]; then
  echo "Error: Berkas distribusi 'dist/index.js' tidak ditemukan setelah build."
  exit 1
fi

# Atomic swap: pindahkan instalasi lama ke backup, lalu tempatkan versi baru
if [ -d "$INSTALL_DIR" ]; then
  TIMESTAMP=$(date +%s)
  BACKUP_DIR="${INSTALL_DIR}.bak.${TIMESTAMP}"
  if [ "$FORCE" -eq 1 ]; then
    echo "Instalasi lama ditemukan. Mencadangkan ke $BACKUP_DIR..."
  else
    echo "Instalasi lama ditemukan. Dicadangkan ke $BACKUP_DIR"
  fi
  mv "$INSTALL_DIR" "$BACKUP_DIR"
fi

mv "$TEMP_DIR" "$INSTALL_DIR"
SWAPPED=1

(
  cd "$INSTALL_DIR"
  # Pastikan dist index dan biner global diberi izin eksekusi
  chmod +x dist/index.js 2>/dev/null || true

  echo "Memasang perintah global 'ruko'..."
  npm install -g .
)

# Amankan izin biner global di Termux maupun Linux biasa
if [ -n "$PREFIX" ] && [ -f "$PREFIX/bin/ruko" ]; then
  chmod +x "$PREFIX/bin/ruko"
elif [ -f "/usr/local/bin/ruko" ]; then
  chmod +x "/usr/local/bin/ruko"
fi

trap - EXIT
if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
  if [ "$FORCE" -eq 1 ]; then
    echo "Membersihkan cadangan sementara mode --force..."
    rm -rf "$BACKUP_DIR"
  else
    echo "Cadangan instalasi sebelumnya tersimpan di: $BACKUP_DIR"
  fi
fi

echo ""
echo "Instalasi selesai!"
echo "Masuk ke direktori proyek Anda lalu ketik: ruko"
