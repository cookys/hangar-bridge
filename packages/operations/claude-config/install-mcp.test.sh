#!/usr/bin/env bash

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="${SCRIPT_DIR}/install-mcp.sh"
MCP_KEY="hangar-bridge-peer-agent"
FAILURES=0

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  FAILURES=$((FAILURES + 1))
}

new_fixture() {
  FIXTURE_DIR="$(mktemp -d)"
  TEST_HOME="${FIXTURE_DIR}/home"
  TEST_REPO="${FIXTURE_DIR}/repo"
  mkdir -p "${TEST_HOME}" "${TEST_REPO}/packages/peer-agent/dist" \
    "${TEST_REPO}/packages/peer-agent/bin"
  printf 'fixture\n' > "${TEST_REPO}/packages/peer-agent/dist/index.js"
  printf '#!/usr/bin/env bash\nexit 0\n' > "${TEST_REPO}/packages/peer-agent/bin/peer-agent.sh"
  chmod +x "${TEST_REPO}/packages/peer-agent/bin/peer-agent.sh"
}

cleanup_fixture() {
  rm -rf "${FIXTURE_DIR}"
}

run_installer() {
  HOME="${TEST_HOME}" REPO_DIR="${TEST_REPO}" bash "${INSTALLER}" "$@"
}

test_writes_required_mcp_key_and_keeps_it_on_rerun() {
  new_fixture
  printf '%s\n' \
    '{"mcpServers":{"hangar-bridge-peer-agent":{"env":{"HANGAR_CONFIG_DIR":"/fixture/project"}}}}' \
    > "${TEST_HOME}/.claude.json"

  if ! run_installer > "${FIXTURE_DIR}/first.out" 2>&1; then
    fail 'initial MCP install should succeed'
    cleanup_fixture
    return
  fi

  if ! jq -e --arg key "${MCP_KEY}" \
    '.mcpServers[$key].env.HANGAR_MCP_KEY == $key' \
    "${TEST_HOME}/.claude.json" >/dev/null; then
    fail 'initial MCP install must write a non-empty canonical HANGAR_MCP_KEY'
  fi
  if ! jq -e --arg key "${MCP_KEY}" \
    '.mcpServers[$key].env.HANGAR_CONFIG_DIR == "/fixture/project"' \
    "${TEST_HOME}/.claude.json" >/dev/null; then
    fail 'MCP install must preserve other managed-entry environment settings'
  fi

  if ! run_installer > "${FIXTURE_DIR}/second.out" 2>&1; then
    fail 'idempotent MCP reinstall should succeed'
    cleanup_fixture
    return
  fi

  if ! jq -e --arg key "${MCP_KEY}" \
    '.mcpServers[$key].env.HANGAR_MCP_KEY == $key' \
    "${TEST_HOME}/.claude.json" >/dev/null; then
    fail 'MCP reinstall must retain the canonical HANGAR_MCP_KEY'
  fi

  cleanup_fixture
}

test_dry_run_writes_nothing_when_config_is_missing() {
  new_fixture

  if ! run_installer --dry-run > "${FIXTURE_DIR}/dry-run.out" 2>&1; then
    fail 'MCP dry-run with a missing config should succeed'
    cleanup_fixture
    return
  fi

  if [[ -e "${TEST_HOME}/.claude.json" ]] || \
    find "${TEST_HOME}" -mindepth 1 -print -quit | grep -q .; then
    fail 'MCP dry-run must not create config, backup, or temporary files'
  fi

  cleanup_fixture
}

test_dry_run_does_not_modify_or_back_up_existing_config() {
  new_fixture
  printf '{"mcpServers":{"existing":{"command":"safe"}}}\n' > "${TEST_HOME}/.claude.json"
  BEFORE="$(sha256sum "${TEST_HOME}/.claude.json")"

  if ! run_installer --dry-run > "${FIXTURE_DIR}/dry-run.out" 2>&1; then
    fail 'MCP dry-run with an existing config should succeed'
    cleanup_fixture
    return
  fi

  AFTER="$(sha256sum "${TEST_HOME}/.claude.json")"
  if [[ "${AFTER}" != "${BEFORE}" ]]; then
    fail 'MCP dry-run must not modify the existing config'
  fi
  if find "${TEST_HOME}" -maxdepth 1 -name '.claude.json.bak.*' -print -quit | grep -q .; then
    fail 'MCP dry-run must not create a backup'
  fi

  cleanup_fixture
}

test_output_does_not_expose_existing_environment_secrets() {
  new_fixture
  printf '%s\n' \
    '{"mcpServers":{"hangar-bridge-peer-agent":{"command":"SECRET_SENTINEL_DO_NOT_PRINT","args":["SECRET_SENTINEL_DO_NOT_PRINT"],"env":{"TOKEN":"SECRET_SENTINEL_DO_NOT_PRINT"}}}}' \
    > "${TEST_HOME}/.claude.json"

  if ! run_installer --dry-run > "${FIXTURE_DIR}/dry-run.out" 2>&1; then
    fail 'secret-redaction MCP dry-run should succeed'
    cleanup_fixture
    return
  fi

  if rg -q 'SECRET_SENTINEL_DO_NOT_PRINT' "${FIXTURE_DIR}/dry-run.out"; then
    fail 'MCP installer output must not expose existing environment secrets'
  fi

  cleanup_fixture
}

test_writes_required_mcp_key_and_keeps_it_on_rerun
test_dry_run_writes_nothing_when_config_is_missing
test_dry_run_does_not_modify_or_back_up_existing_config
test_output_does_not_expose_existing_environment_secrets

if ((FAILURES > 0)); then
  printf '%d MCP installer regression(s) failed.\n' "${FAILURES}" >&2
  exit 1
fi

printf 'PASS: install-mcp regressions\n'
