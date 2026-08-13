#!/bin/bash
# Detectra pre-publish audit — MUST pass before any git push or model upload.
# Generic scans (emails, home paths, model binaries, secrets) plus any extra
# terms listed in tools/.audit-terms (gitignored, one regex per line — keeps
# sensitive scan targets out of the public repo).
# Exit 0 = clean; exit 1 = findings (publish NOTHING).
set -u
cd "$(dirname "$0")/.."
SELF=':(exclude)tools/prepublish-audit.sh'
fail=0

TERMS=""
[ -f tools/.audit-terms ] && TERMS=$(grep -v '^#' tools/.audit-terms | paste -sd'|' -)

echo "== 1. commit identities + messages"
if git log --all --format='%an %ae %cn %ce' | grep -vqE 'users\.noreply\.github\.com|^Ash Hart'; then
  echo "   FAIL: unexpected identity"; git log --all --format='%an <%ae> | %cn <%ce>' | sort -u; fail=1
else echo "   clean (noreply-only)"; fi
if [ -n "$TERMS" ] && git log --all --format='%B' | grep -qiE "$TERMS"; then
  echo "   FAIL: term in commit message"; fail=1
fi

echo "== 2. extra terms in all blobs, all commits"
if [ -n "$TERMS" ] && git grep -qiE "$TERMS" $(git rev-list --all) -- . "$SELF" 2>/dev/null; then
  echo "   FAIL:"; git grep -ilE "$TERMS" $(git rev-list --all) -- . "$SELF" | head; fail=1
else echo "   clean"; fi

echo "== 3. emails in tracked text files"
hits=$(git grep -IhoE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' | sort -u | grep -v 'users.noreply.github.com' || true)
if [ -n "$hits" ]; then echo "   FAIL: $hits"; fail=1; else echo "   clean (noreply-only)"; fi

echo "== 4. home-dir paths in any blob"
if git grep -qE '/Users/[a-z]' $(git rev-list --all) -- . "$SELF" 2>/dev/null; then
  echo "   FAIL:"; git grep -lE '/Users/[a-z]' $(git rev-list --all) -- . "$SELF" | head; fail=1
else echo "   clean"; fi

echo "== 5. model binary internals"
if [ -f extension/models/model.onnx ]; then
  found=$(strings extension/models/model.onnx | grep -iE '/Users/[a-z]|@[a-z0-9-]+\.(com|org|net)' | head -3 || true)
  if [ -n "$TERMS" ]; then
    found="$found$(strings extension/models/model.onnx | grep -iE "$TERMS" | grep -v stash_type | head -3 || true)"
  fi
  if [ -n "$found" ]; then echo "   FAIL: onnx embeds: $found"; fail=1; else echo "   onnx clean"; fi
fi

echo "== 6. token patterns in tracked files"
if git grep -qE '(hf|ghp|gho|sk)_[A-Za-z0-9]{30,}' $(git rev-list --all) -- . "$SELF" 2>/dev/null; then
  echo "   FAIL: token-like string tracked!"; fail=1
else echo "   clean"; fi

[ $fail -eq 0 ] && echo "AUDIT PASS — safe to publish" || echo "AUDIT FAIL — do not publish"
exit $fail
