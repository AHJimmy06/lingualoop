#!/bin/sh
set -eu

# This release implements the Initialized piper / JSONL / output_file protocol
# used by piper-host.ts. Do not replace it with the Python CLI without testing.
version=2023.11.14-2
case "${1:-}" in
  amd64)
    arch=x86_64
    sha256=a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992
    ;;
  arm64)
    arch=aarch64
    sha256=fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb
    ;;
  *) echo 'Unsupported Piper architecture (expected amd64 or arm64)' >&2; exit 1 ;;
esac

archive="$(mktemp)"
trap 'rm -f "$archive"' EXIT
curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
  "https://github.com/rhasspy/piper/releases/download/$version/piper_linux_$arch.tar.gz" \
  --output "$archive"
printf '%s  %s\n' "$sha256" "$archive" | sha256sum --check --status
# Preserve shared libraries, symlinks and espeak-ng-data beside the executable.
mkdir -p /opt/piper
tar -xzf "$archive" -C /opt/piper --strip-components=1
test -d /opt/piper/espeak-ng-data
/opt/piper/piper --help >/dev/null 2>&1
