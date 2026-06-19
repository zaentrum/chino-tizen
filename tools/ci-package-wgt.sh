#!/usr/bin/env bash
# CI: install the Tizen Studio CLI, materialise the signing profile from CI
# variables, build, and package a signed .wgt.
#
# Required env (protected GitLab CI variables):
#   TIZEN_AUTHOR_P12_B64   base64 of the author certificate (.p12)
#   TIZEN_AUTHOR_PASSWORD  author certificate password
# Optional:
#   TIZEN_HOME             install dir (default ./.tizen-studio)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "${TIZEN_AUTHOR_P12_B64:-}" ] || [ -z "${TIZEN_AUTHOR_PASSWORD:-}" ]; then
  echo "TIZEN_AUTHOR_P12_B64 / TIZEN_AUTHOR_PASSWORD not set — skipping .wgt packaging." >&2
  exit 0
fi

# The Tizen installer refuses to run as root. CI runs as root, so install the
# system deps + create an unprivileged user, hand it the workspace, then
# re-exec this script (with env preserved) as that user.
if [ "$(id -u)" = "0" ]; then
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends \
    openjdk-17-jre-headless libpng16-16 ca-certificates sudo passwd >/dev/null
  id tizenbuilder >/dev/null 2>&1 || useradd -m -s /bin/bash tizenbuilder
  chown -R tizenbuilder:tizenbuilder "$ROOT"
  BHOME="$(getent passwd tizenbuilder | cut -d: -f6)"
  # The Tizen installer rejects a destination under the build dir / a hidden
  # dir, and writes its package-manager into $HOME — so run with the builder's
  # real HOME and install into it (matches the known-good local layout).
  exec sudo -u tizenbuilder env "HOME=$BHOME" "PATH=$PATH" \
    "TIZEN_AUTHOR_P12_B64=$TIZEN_AUTHOR_P12_B64" \
    "TIZEN_AUTHOR_PASSWORD=$TIZEN_AUTHOR_PASSWORD" \
    bash "$0" "$@"
fi

# --- everything below runs as the unprivileged user ---
TIZEN_HOME="${TIZEN_HOME:-$HOME/tizen-studio}"
TIZEN_DATA="${TIZEN_HOME}-data" # Tizen derives the data dir as <install>-data
INSTALLER_URL="http://download.tizen.org/sdk/Installer/tizen-studio_6.1/web-cli_Tizen_Studio_6.1_ubuntu-64.bin"
export PATH="$TIZEN_HOME/tools/ide/bin:$TIZEN_HOME/tools:$PATH"

# 1) install the CLI.
if [ ! -x "$TIZEN_HOME/tools/ide/bin/tizen" ]; then
  echo "Installing Tizen Studio CLI 6.1 -> $TIZEN_HOME"
  curl -fsSL -o /tmp/tizen-cli.bin "$INSTALLER_URL"
  chmod +x /tmp/tizen-cli.bin
  /tmp/tizen-cli.bin --accept-license "$TIZEN_HOME"
fi

# 2) author cert from the CI var + a signing profile with INLINE passwords.
# The headless `tizen security-profiles add` does not write the encrypted .pwd
# files, so the signer would read the .pwd *path* as the password and fail with
# "Invaild password" — writing the literal passwords into profiles.xml fixes it.
mkdir -p "$TIZEN_DATA/keystore/author" "$TIZEN_DATA/profile"
echo "$TIZEN_AUTHOR_P12_B64" | base64 -d > "$TIZEN_DATA/keystore/author/chino-author.p12"
DIST="$TIZEN_HOME/tools/certificate-generator/certificates/distributor/tizen-distributor-signer.p12"
DCA="$TIZEN_HOME/tools/certificate-generator/certificates/distributor/tizen-distributor-ca.cer"
cat > "$TIZEN_DATA/profile/profiles.xml" <<EOF
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<profiles active="chino" version="3.1">
<profile name="chino">
<profileitem ca="" distributor="0" key="$TIZEN_DATA/keystore/author/chino-author.p12" password="$TIZEN_AUTHOR_PASSWORD" rootca=""/>
<profileitem ca="$DCA" distributor="1" key="$DIST" password="tizenpkcs12passfordsigner" rootca=""/>
<profileitem ca="" distributor="2" key="" password="" rootca=""/>
</profile>
</profiles>
EOF
tizen cli-config "profiles.path=$TIZEN_DATA/profile/profiles.xml" >/dev/null

# 3) build the bundle + package the signed .wgt.
TIZEN_PROFILE=chino STAGE_DIR="$ROOT/.buildResult" bash "$ROOT/tools/package-wgt.sh"
echo "-> packaged $ROOT/.buildResult/Chino.wgt"
ls -lh "$ROOT/.buildResult/Chino.wgt"
