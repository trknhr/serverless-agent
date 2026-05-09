#!/usr/bin/env bash
set -euo pipefail

go_bin=""

if [[ -n "${GO_BIN:-}" ]]; then
  go_bin="${GO_BIN}"
elif command -v go >/dev/null 2>&1; then
  go_bin="go"
elif [[ -x "${HOME}/.local/go1.26.3/bin/go" ]]; then
  go_bin="${HOME}/.local/go1.26.3/bin/go"
else
  echo "go toolchain not found. Install Go or set GO_BIN." >&2
  exit 1
fi

if [[ "$#" -ge 2 ]]; then
  expanded_args=()
  replaced=false
  for arg in "$@"; do
    if [[ "${arg}" != "./..." ]]; then
      expanded_args+=("${arg}")
      continue
    fi

    replaced=true
    expanded_args+=("./cmd/..." "./internal/...")
  done

  if [[ "${replaced}" == "true" ]]; then
    exec "${go_bin}" "${expanded_args[@]}"
  fi
fi

exec "${go_bin}" "$@"
