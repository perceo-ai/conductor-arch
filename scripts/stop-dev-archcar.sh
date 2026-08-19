#!/usr/bin/env bash
set -euo pipefail

dry_run=0
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=1
fi

bin="${ARCHDUCTOR_ARCHCAR_BIN:-}"
if [[ -z "$bin" ]]; then
  echo "ARCHDUCTOR_ARCHCAR_BIN is not set; no dev archcar to stop."
  exit 0
fi

pids=()
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"
  [[ -n "$line" ]] || continue

  pid="${line%%[[:space:]]*}"
  args="${line#"$pid"}"
  args="${args#"${args%%[![:space:]]*}"}"

  [[ "$args" == "$bin" ]] || continue
  [[ "$pid" == "$$" ]] && continue
  pids+=("$pid")
done < <(ps -axo pid=,args=)

if [[ "${#pids[@]}" -eq 0 ]]; then
  echo "No branch dev archcar running for $bin."
  exit 0
fi

if [[ "$dry_run" -eq 1 ]]; then
  echo "Would stop branch dev archcar pid(s): ${pids[*]}"
  exit 0
fi

echo "Stopping branch dev archcar pid(s): ${pids[*]}"
kill "${pids[@]}" 2>/dev/null || true

for _ in {1..20}; do
  alive=()
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      alive+=("$pid")
    fi
  done

  if [[ "${#alive[@]}" -eq 0 ]]; then
    exit 0
  fi

  sleep 0.1
done

echo "Timed out waiting for branch dev archcar pid(s) to stop: ${alive[*]}" >&2
exit 1
