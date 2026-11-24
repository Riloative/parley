#!/bin/sh
# Install the standalone taria binary.
#
#   curl -fsSL https://raw.githubusercontent.com/Riloative/taria/main/install.sh | sh
#
# Environment:
#   TARIA_VERSION      release tag to install, e.g. v0.2.0 (default: latest)
#   TARIA_INSTALL_DIR  where to put the binary (default: ~/.local/bin)
#   TARIA_RELEASES_URL base URL of the releases (default: GitHub); used for
#                       mirrors and tests
#
# The whole script is a function that is only called on the last line, so a
# download cut short never runs half a script. It never uses sudo.

taria_install() {
  set -eu

  # PARLEY_* are the names from before the rename; they still work.
  repo_releases="${TARIA_RELEASES_URL:-${PARLEY_RELEASES_URL:-https://github.com/Riloative/taria/releases}}"
  install_dir="${TARIA_INSTALL_DIR:-${PARLEY_INSTALL_DIR:-$HOME/.local/bin}}"
  version="${TARIA_VERSION:-${PARLEY_VERSION:-latest}}"

  say() { printf '%s\n' "$*"; }
  die() {
    printf 'taria install: %s\n' "$*" >&2
    exit 1
  }

  os="${TARIA_OS:-${PARLEY_OS:-$(uname -s)}}"
  arch="${TARIA_ARCH:-${PARLEY_ARCH:-$(uname -m)}}"
  case "$os" in
    Linux | linux) os=linux ;;
    Darwin | darwin) os=darwin ;;
    *) die "unsupported operating system: $os (taria binaries exist for macOS and Linux)" ;;
  esac
  case "$arch" in
    x86_64 | amd64 | x64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) die "unsupported architecture: $arch (taria binaries exist for Linux x64 and Apple Silicon Macs)" ;;
  esac
  # An x64 shell under Rosetta on Apple Silicon still wants the arm64 build.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ -z "${TARIA_ARCH:-}${PARLEY_ARCH:-}" ]; then
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi
  fi
  # Binaries are published for the platforms taria is built and tested on.
  case "$os-$arch" in
    linux-x64 | darwin-arm64) ;;
    *)
      printf 'taria install: there is no taria binary for %s (binaries exist for Linux x64 and Apple Silicon Macs).\n' "$os-$arch" >&2
      printf 'Install the npm package instead; it runs anywhere Node.js 22 or newer does:\n' >&2
      printf '  https://github.com/Riloative/taria#npm-nodejs-22-or-newer\n' >&2
      exit 1
      ;;
  esac
  asset="taria-$os-$arch.tar.gz"

  if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
  elif command -v wget >/dev/null 2>&1; then
    fetch() { wget -q -O "$2" "$1"; }
  else
    die "needs curl or wget to download the release"
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
  elif command -v shasum >/dev/null 2>&1; then
    sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
  else
    die "needs sha256sum or shasum to verify the download; refusing to install unverified"
  fi

  if [ "$version" = latest ]; then
    base="$repo_releases/latest/download"
  else
    case "$version" in v*) ;; *) version="v$version" ;; esac
    base="$repo_releases/download/$version"
  fi

  tmp="$(mktemp -d 2>/dev/null || mktemp -d -t taria)"
  trap 'rm -rf "$tmp"' EXIT INT TERM

  say "Downloading $asset ($version)…"
  fetch "$base/$asset" "$tmp/$asset" || die "could not download $base/$asset"
  fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || die "could not download $base/SHA256SUMS"

  expected="$(awk -v a="$asset" '$2 == a || $2 == "*" a { print $1 }' "$tmp/SHA256SUMS")"
  [ -n "$expected" ] || die "$asset is not listed in SHA256SUMS"
  actual="$(sha256 "$tmp/$asset")"
  [ "$expected" = "$actual" ] || die "checksum mismatch for $asset (expected $expected, got $actual); not installing"

  tar -xzf "$tmp/$asset" -C "$tmp" taria || die "could not unpack $asset"
  [ -f "$tmp/taria" ] || die "$asset does not contain a taria binary"
  chmod 755 "$tmp/taria"

  mkdir -p "$install_dir" || die "cannot create $install_dir"
  # Copy next to the destination first, then rename: the replacement is
  # atomic, so a running taria or an interrupted install never sees a
  # half-written file.
  staged="$install_dir/.taria.tmp.$$"
  cp "$tmp/taria" "$staged" || die "cannot write to $install_dir"
  mv -f "$staged" "$install_dir/taria" || {
    rm -f "$staged"
    die "cannot install into $install_dir"
  }

  # The `parley` alias (0.3.x only): replaces an old parley binary, so that
  # command keeps working and runs taria.
  if tar -xzf "$tmp/$asset" -C "$tmp" parley 2>/dev/null && [ -f "$tmp/parley" ]; then
    alias_staged="$install_dir/.parley.tmp.$$"
    if cp "$tmp/parley" "$alias_staged" && chmod 755 "$alias_staged" && mv -f "$alias_staged" "$install_dir/parley"; then
      say "Installed $install_dir/parley as an alias for taria (until taria 0.4.0)."
    else
      rm -f "$alias_staged"
    fi
  fi

  if installed="$("$install_dir/taria" --version 2>"$tmp/err")"; then
    say "Installed $install_dir/taria — $installed"
  else
    say "Installed $install_dir/taria, but it does not start on this system:"
    sed 's/^/  /' "$tmp/err"
    if grep -q libatomic "$tmp/err"; then
      say "It needs the libatomic library: sudo apt install libatomic1 (Debian/Ubuntu) or sudo dnf install libatomic (Fedora/RHEL)."
    elif grep -q GLIBC_ "$tmp/err"; then
      say "It needs glibc 2.28 or newer (Debian 10, Ubuntu 20.04, RHEL 8 or later). Use the npm package instead on older systems."
    fi
    exit 1
  fi
  if [ "$os" = darwin ]; then
    say "(Downloaded with curl, so macOS does not quarantine it. If Gatekeeper ever blocks it: xattr -d com.apple.quarantine \"$install_dir/taria\")"
  fi
  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *)
      say ""
      say "$install_dir is not on your PATH. Add this line to your shell profile (~/.zshrc, ~/.bashrc, …):"
      say "  export PATH=\"$install_dir:\$PATH\""
      ;;
  esac
}

taria_install "$@"
