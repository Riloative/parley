#!/bin/sh
# Install the standalone parley binary.
#
#   curl -fsSL https://raw.githubusercontent.com/Riloative/parley/main/install.sh | sh
#
# Environment:
#   PARLEY_VERSION      release tag to install, e.g. v0.2.0 (default: latest)
#   PARLEY_INSTALL_DIR  where to put the binary (default: ~/.local/bin)
#   PARLEY_RELEASES_URL base URL of the releases (default: GitHub); used for
#                       mirrors and tests
#
# The whole script is a function that is only called on the last line, so a
# download cut short never runs half a script. It never uses sudo.

parley_install() {
  set -eu

  repo_releases="${PARLEY_RELEASES_URL:-https://github.com/Riloative/parley/releases}"
  install_dir="${PARLEY_INSTALL_DIR:-$HOME/.local/bin}"
  version="${PARLEY_VERSION:-latest}"

  say() { printf '%s\n' "$*"; }
  die() {
    printf 'parley install: %s\n' "$*" >&2
    exit 1
  }

  os="${PARLEY_OS:-$(uname -s)}"
  arch="${PARLEY_ARCH:-$(uname -m)}"
  case "$os" in
    Linux | linux) os=linux ;;
    Darwin | darwin) os=darwin ;;
    *) die "unsupported operating system: $os (parley binaries exist for macOS and Linux)" ;;
  esac
  case "$arch" in
    x86_64 | amd64 | x64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) die "unsupported architecture: $arch (parley binaries exist for x64 and arm64)" ;;
  esac
  # An x64 shell under Rosetta on Apple Silicon still wants the arm64 build.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ -z "${PARLEY_ARCH:-}" ]; then
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi
  fi
  asset="parley-$os-$arch.tar.gz"

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

  tmp="$(mktemp -d 2>/dev/null || mktemp -d -t parley)"
  trap 'rm -rf "$tmp"' EXIT INT TERM

  say "Downloading $asset ($version)…"
  fetch "$base/$asset" "$tmp/$asset" || die "could not download $base/$asset"
  fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || die "could not download $base/SHA256SUMS"

  expected="$(awk -v a="$asset" '$2 == a || $2 == "*" a { print $1 }' "$tmp/SHA256SUMS")"
  [ -n "$expected" ] || die "$asset is not listed in SHA256SUMS"
  actual="$(sha256 "$tmp/$asset")"
  [ "$expected" = "$actual" ] || die "checksum mismatch for $asset (expected $expected, got $actual); not installing"

  tar -xzf "$tmp/$asset" -C "$tmp" parley || die "could not unpack $asset"
  [ -f "$tmp/parley" ] || die "$asset does not contain a parley binary"
  chmod 755 "$tmp/parley"

  mkdir -p "$install_dir" || die "cannot create $install_dir"
  # Copy next to the destination first, then rename: the replacement is
  # atomic, so a running parley or an interrupted install never sees a
  # half-written file.
  staged="$install_dir/.parley.tmp.$$"
  cp "$tmp/parley" "$staged" || die "cannot write to $install_dir"
  mv -f "$staged" "$install_dir/parley" || {
    rm -f "$staged"
    die "cannot install into $install_dir"
  }

  if installed="$("$install_dir/parley" --version 2>"$tmp/err")"; then
    say "Installed $install_dir/parley — $installed"
  else
    say "Installed $install_dir/parley, but it does not start on this system:"
    sed 's/^/  /' "$tmp/err"
    if grep -q libatomic "$tmp/err"; then
      say "It needs the libatomic library: sudo apt install libatomic1 (Debian/Ubuntu) or sudo dnf install libatomic (Fedora/RHEL)."
    elif grep -q GLIBC_ "$tmp/err"; then
      say "It needs glibc 2.28 or newer (Debian 10, Ubuntu 20.04, RHEL 8 or later). Use the npm package instead on older systems."
    fi
    exit 1
  fi
  if [ "$os" = darwin ]; then
    say "(Downloaded with curl, so macOS does not quarantine it. If Gatekeeper ever blocks it: xattr -d com.apple.quarantine \"$install_dir/parley\")"
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

parley_install "$@"
