#!/bin/sh
# Investigation only (0.4.0): can the macOS `security` tool store a key
# without the key being a command-line argument? Runs in a throwaway keychain
# on the macOS CI runner and prints what works. Nothing in taria uses this.
set -u
[ "$(uname -s)" = Darwin ] || { echo "not macOS: nothing to probe"; exit 0; }
KC="${RUNNER_TEMP:-/tmp}/taria-probe-$$.keychain-db"
PW=probe-password
security create-keychain -p "$PW" "$KC" && security unlock-keychain -p "$PW" "$KC" || { echo "PROBE: could not create a throwaway keychain"; exit 0; }
trap 'security delete-keychain "$KC" 2>/dev/null' EXIT
get() { security find-generic-password -s taria-probe -a "$1" -w "$KC" 2>/dev/null; }
SIMPLE='sk-test-FAKE-simple-0123456789'
HARD='sk-test FAKE "quoted" \back $dollar '"'"'single'"'"' -dash'

echo "== 1. today's way: the key as an argument"
security add-generic-password -U -s taria-probe -a argv -w "$HARD" "$KC"; echo "PROBE argv add rc=$?"
[ "$(get argv)" = "$HARD" ] && echo "PROBE argv round trip: ok" || echo "PROBE argv round trip: MISMATCH"

echo "== 2. security -i: commands on stdin (the key is not in any argv)"
printf 'add-generic-password -U -s taria-probe -a stdin-simple -w %s "%s"\n' "$SIMPLE" "$KC" | security -i; echo "PROBE -i simple add rc=$?"
[ "$(get stdin-simple)" = "$SIMPLE" ] && echo "PROBE -i simple round trip: ok" || echo "PROBE -i simple round trip: MISMATCH (got $(get stdin-simple | wc -c) bytes)"

echo "== 3. security -i with a key that needs quoting (double quotes, backslash-escaped)"
ESC=$(printf '%s' "$HARD" | sed 's/\\/\\\\/g; s/"/\\"/g')
printf 'add-generic-password -U -s taria-probe -a stdin-hard -w "%s" "%s"\n' "$ESC" "$KC" | security -i; echo "PROBE -i hard add rc=$?"
[ "$(get stdin-hard)" = "$HARD" ] && echo "PROBE -i hard round trip: ok" || echo "PROBE -i hard round trip: MISMATCH (got $(get stdin-hard | wc -c) bytes, want $(printf '%s' "$HARD" | wc -c))"

echo "== 4. -w last with no value: does the prompt read stdin when there is no terminal?"
printf '%s\n%s\n' "$SIMPLE" "$SIMPLE" | security add-generic-password -U -s taria-probe -a prompt "$KC" -w 2>&1 | sed 's/^/   /'; echo "PROBE prompt add rc=$?"
[ "$(get prompt)" = "$SIMPLE" ] && echo "PROBE prompt round trip: ok" || echo "PROBE prompt round trip: MISMATCH or not stored"

echo "== 5. is the key visible in ps while security -i runs? (a slow second command keeps it alive)"
( printf 'add-generic-password -U -s taria-probe -a ps -w %s "%s"\n' "$SIMPLE" "$KC"; sleep 2 ) | security -i &
sleep 1
if ps -axo args | grep -v grep | grep -q "$SIMPLE"; then echo "PROBE ps during -i: KEY VISIBLE"; else echo "PROBE ps during -i: key not in any argv"; fi
wait
echo "== done; macOS $(sw_vers -productVersion)"
