#!/usr/bin/env bash
# PromptIQ: one-command local setup for macOS (Apple Silicon or Intel).
#
#   bash setup-mac.sh                 # installs into ~/promptiq
#   PROMPTIQ_DIR=~/code/promptiq bash setup-mac.sh
#
# What it does (safe to re-run; every step skips work already done):
#   1. Installs Homebrew if missing, then Node 22 and PostgreSQL 16 via Homebrew
#   2. Starts PostgreSQL as a background service and creates the promptiq
#      database and user (password: promptiq, local only)
#   3. Clones github.com/drudoshanks/promptiq and checks out the latest feature
#      branch (prompt library + token/cost engine)
#   4. Creates .env.local with a fresh AUTH_SECRET and the offline mock optimiser
#   5. Installs npm packages and applies the database migrations
set -euo pipefail

REPO_URL="https://github.com/drudoshanks/promptiq.git"
BRANCH="${PROMPTIQ_BRANCH:-feature/prompt-library}"
DIR="${PROMPTIQ_DIR:-$HOME/promptiq}"
DB_URL="postgresql://promptiq:promptiq@localhost:5432/promptiq"

say()  { printf "\n\033[1;34m==>\033[0m %s\n" "$*"; }
ok()   { printf "    \033[32m✓\033[0m %s\n" "$*"; }
fail() { printf "\n\033[1;31mSetup stopped:\033[0m %s\n" "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || fail "this script is for macOS."

# --- 1. Command line tools + Homebrew ---------------------------------------
say "Checking Apple command line tools"
if ! xcode-select -p >/dev/null 2>&1; then
  xcode-select --install || true
  fail "a window opened to install Apple's command line tools. Finish that install, then run this script again."
fi
ok "command line tools present"

say "Checking Homebrew"
if ! command -v brew >/dev/null 2>&1; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [[ -x $b ]] && eval "$($b shellenv)" && break; done
fi
if ! command -v brew >/dev/null 2>&1; then
  echo "    Homebrew is not installed. Installing it now (it will ask for your Mac password)."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [[ -x $b ]] && eval "$($b shellenv)" && break; done
  command -v brew >/dev/null 2>&1 || fail "Homebrew installed but is not on PATH. Open a new Terminal window and run this script again."
fi
ok "Homebrew $(brew --version | head -1 | awk '{print $2}')"

# --- Node 22 -----------------------------------------------------------------
say "Checking Node.js (22 or newer)"
node_major() { node -v 2>/dev/null | sed 's/^v//; s/\..*//'; }
if [[ -z "$(node_major)" || "$(node_major)" -lt 22 ]]; then
  brew list node@22 >/dev/null 2>&1 || brew install node@22
  NODE_PREFIX="$(brew --prefix node@22)"
  export PATH="$NODE_PREFIX/bin:$PATH"
  NODE_NOTE="Node 22 was installed with Homebrew but is not your default. To use it in new windows, run:  echo 'export PATH=\"$(brew --prefix node@22)/bin:\$PATH\"' >> ~/.zshrc"
fi
[[ "$(node_major)" -ge 22 ]] || fail "Node 22+ is still not available (found $(node -v 2>/dev/null || echo none))."
ok "Node $(node -v)"

# --- 2. PostgreSQL 16 --------------------------------------------------------
say "Checking PostgreSQL 16"
brew list postgresql@16 >/dev/null 2>&1 || brew install postgresql@16
PG_BIN="$(brew --prefix postgresql@16)/bin"
export PATH="$PG_BIN:$PATH"
if ! pg_isready -h localhost -p 5432 -q; then
  brew services start postgresql@16 >/dev/null
  for _ in $(seq 1 30); do pg_isready -h localhost -p 5432 -q && break; sleep 1; done
fi
pg_isready -h localhost -p 5432 -q || fail "PostgreSQL did not start on port 5432. Check: brew services list"
ok "PostgreSQL is running on localhost:5432"

say "Creating the promptiq database and user"
if psql "$DB_URL" -Atc "select 1" >/dev/null 2>&1; then
  ok "database already set up"
else
  # Connect as the Mac user, who owns a Homebrew Postgres install.
  ADMIN="psql -h localhost -d postgres -v ON_ERROR_STOP=1 -Atq"
  $ADMIN -c "select 1" >/dev/null 2>&1 || fail "cannot connect to PostgreSQL as '$USER'. If another Postgres (Postgres.app or Docker) already uses port 5432, stop it or create user/db 'promptiq' (password 'promptiq') there yourself."
  if [[ -z "$($ADMIN -c "select 1 from pg_roles where rolname='promptiq'")" ]]; then
    $ADMIN -c "create role promptiq login password 'promptiq'"
  fi
  if [[ -z "$($ADMIN -c "select 1 from pg_database where datname='promptiq'")" ]]; then
    $ADMIN -c "create database promptiq owner promptiq"
  fi
  psql "$DB_URL" -Atc "select 1" >/dev/null || fail "created the database but cannot log in as promptiq."
  ok "database promptiq ready"
fi

# --- 3. Code -----------------------------------------------------------------
say "Getting the code into $DIR"
if [[ -d "$DIR/.git" ]]; then
  git -C "$DIR" fetch origin --quiet
else
  git clone --quiet "$REPO_URL" "$DIR" || fail "git clone failed. If the repository is private, sign in first (for example: brew install gh && gh auth login), then run this again."
fi
cd "$DIR"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "    You have local changes; leaving the current branch ($(git branch --show-current)) as it is."
else
  git checkout --quiet "$BRANCH" 2>/dev/null || git checkout --quiet -b "$BRANCH" "origin/$BRANCH"
  git pull --quiet --ff-only origin "$BRANCH" || true
fi
ok "on branch $(git branch --show-current) at $(git rev-parse --short HEAD)"

# --- 4. Environment file -----------------------------------------------------
say "Creating .env.local"
if [[ -f .env.local ]]; then
  ok ".env.local already exists; not touching it"
else
  cp .env.example .env.local
  SECRET="$(openssl rand -base64 32 | tr -d '\n' | sed 's/[\/&]/\\&/g')"
  sed -i '' "s/^AUTH_SECRET=.*/AUTH_SECRET=${SECRET}/" .env.local
  sed -i '' "s#^DATABASE_URL=.*#DATABASE_URL=${DB_URL}#" .env.local
  ok "written (mock optimiser, no API key needed)"
fi

# --- 5. Packages + migrations ------------------------------------------------
say "Installing npm packages (a minute or two the first time)"
npm ci --no-audit --no-fund --loglevel=error
ok "packages installed"

say "Applying database migrations"
npm run --silent db:migrate
ok "database schema is up to date"

cat <<EOF

$(printf "\033[1;32mPromptIQ is set up.\033[0m")

  Start it:     cd "$DIR" && npm run dev
  Then open:    http://localhost:3000   (create an account with any email)

  Password-reset links print in the Terminal window instead of being emailed.
  The optimiser runs in offline mock mode. For real AI rewrites and analysis,
  edit .env.local:  OPTIMISER_PROVIDER=openai  and  OPENAI_API_KEY=sk-...

  Stop the database later with:  brew services stop postgresql@16
EOF
[[ -n "${NODE_NOTE:-}" ]] && printf "\n  Note: %s\n" "$NODE_NOTE"
exit 0
