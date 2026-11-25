#!/usr/bin/env sh
# kilo-gateway installer for Linux and Termux.
#
#   curl -fsSL https://raw.githubusercontent.com/dumbzombies/kilo-gateway/main/install.sh | sh
#
# Installs Bun if missing, clones the repo, builds a single self-contained
# binary, and prints the dashboard URL. Re-running upgrades in place.
#
# Environment overrides:
#   KG_DIR        install directory        (default: ~/.local/share/kilo-gateway)
#   KG_BIN_DIR    where the binary goes    (default: ~/.local/bin)
#   KG_PORT       port for the printed URL (default: 8080)
#   KG_NO_BUILD   set to 1 to run from source instead of compiling

set -eu

REPO="https://github.com/dumbzombies/kilo-gateway.git"
DIR="${KG_DIR:-$HOME/.local/share/kilo-gateway}"
BIN_DIR="${KG_BIN_DIR:-$HOME/.local/bin}"
PORT="${KG_PORT:-8080}"

info() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;31mwarn:\033[0m %s\n' "$*" >&2; }
die() { warn "$*"; exit 1; }

is_termux() { [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux ]; }

# ---- prerequisites ---------------------------------------------------------

if ! command -v curl >/dev/null 2>&1; then
  if command -v wget >/dev/null 2>&1; then
    curl() { wget -qO- "$1"; }
  else
    die "need curl or wget"
  fi
fi

if ! command -v git >/dev/null 2>&1; then
  info "installing git"
  if is_termux; then pkg install -y git
  elif command -v apt-get >/dev/null 2>&1; then sudo apt-get update -qq && sudo apt-get install -y git
  elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y git
  elif command -v pacman >/dev/null 2>&1; then sudo pacman -S --noconfirm git
  else die "install git and re-run"; fi
fi

# ---- bun -------------------------------------------------------------------

if ! command -v bun >/dev/null 2>&1; then
  info "installing Bun"
  if is_termux; then
    # Termux has no glibc, so Bun's official installer does not apply.
    pkg install -y bun 2>/dev/null || die "Bun is not in your Termux repos yet. See https://bun.sh/docs/installation"
  else
    curl -fsSL https://bun.sh/install | bash
    # shellcheck disable=SC1091
    [ -f "$HOME/.bun/bin/bun" ] && PATH="$HOME/.bun/bin:$PATH"
    export PATH
  fi
fi

command -v bun >/dev/null 2>&1 || die "bun is still not on PATH; add ~/.bun/bin to PATH and re-run"
info "bun $(bun --version)"

# ---- source ----------------------------------------------------------------

if [ -d "$DIR/.git" ]; then
  info "updating $DIR"
  git -C "$DIR" pull --ff-only --quiet || warn "could not fast-forward; keeping the existing checkout"
else
  info "cloning into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 --quiet "$REPO" "$DIR"
fi

cd "$DIR"

# Dependencies are dev-only (types + typescript); runtime is the Bun stdlib.
info "installing dependencies"
bun install --silent

mkdir -p "$BIN_DIR"

if [ "${KG_NO_BUILD:-0}" = "1" ]; then
  cat > "$BIN_DIR/kilo-gateway" <<EOF
#!/usr/bin/env sh
exec bun "$DIR/src/server.ts" "\$@"
EOF
  chmod +x "$BIN_DIR/kilo-gateway"
  info "installed launcher (source mode) at $BIN_DIR/kilo-gateway"
else
  info "compiling a self-contained binary (about 90 MB)"
  bun build --compile src/server.ts --outfile "$BIN_DIR/kilo-gateway" >/dev/null
  info "installed $BIN_DIR/kilo-gateway"
fi

# ---- data dir --------------------------------------------------------------

DATA_DIR="$HOME/.local/share/kilo-gateway-data"
mkdir -p "$DATA_DIR"

printf '\n\033[1;32mkilo-gateway is installed.\033[0m\n\n'

cat <<EOF

Start it:
  DATA_DIR="$DATA_DIR" kilo-gateway

Then open:
  http://127.0.0.1:$PORT/

Notes:
  • The dashboard is open until you set ADMIN_TOKEN. For anything reachable
    from a network, set one first:
        ADMIN_TOKEN=\$(openssl rand -hex 24) DATA_DIR="$DATA_DIR" kilo-gateway
  • Upstream credentials are pooled in ~/.kilo-gateway/keys.json (mode 600),
    or add them at runtime under Settings → Upstream accounts.
  • WARP egress rotation requires Bun and an HTTP CONNECT proxy; see README.
EOF

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf '\n\033[1;33mheads up:\033[0m %s is not on PATH.\n' "$BIN_DIR"
     printf '  export PATH="%s:%s"\n' "$BIN_DIR" "\$PATH" ;;
esac
