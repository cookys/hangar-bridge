#!/usr/bin/env bash

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="${SCRIPT_DIR}/install-relay.sh"
UNIT_NAME="hangar-bridge-relay.service"
REPO_ROOT="$(git -C "${SCRIPT_DIR}" rev-parse --show-toplevel)"
REVISION="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
RELAY_DIST_INDEX="${REPO_ROOT}/packages/relay/dist/index.js"
RELAY_DIST_PREEXISTED=false
if [[ -e "${RELAY_DIST_INDEX}" ]]; then
  RELAY_DIST_PREEXISTED=true
fi
FAILURES=0

cleanup_generated_dist() {
  if [[ "${RELAY_DIST_PREEXISTED}" != "true" ]]; then
    rm -f "${RELAY_DIST_INDEX}"
    rmdir "$(dirname -- "${RELAY_DIST_INDEX}")" 2>/dev/null || true
  fi
}
trap cleanup_generated_dist EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  FAILURES=$((FAILURES + 1))
}

new_fixture() {
  RELAY_ACTIVE=false
  SYSTEMCTL_FAIL_MATCH=""
  CURL_HEALTHY=true
  CURL_REVISION="${REVISION}"
  CURL_FAILS_BEFORE_SUCCESS=0
  FIXTURE_DIR="$(mktemp -d)"
  TEST_HOME="${FIXTURE_DIR}/home"
  MOCK_BIN="${FIXTURE_DIR}/bin"
  SYSTEMCTL_LOG="${FIXTURE_DIR}/systemctl.log"
  CURL_COUNT_FILE="${FIXTURE_DIR}/curl-count"
  COREPACK_LOG="${FIXTURE_DIR}/corepack.log"
  GIT_STATUS_OUTPUT=""
  REVISION_FILE="${TEST_HOME}/.config/hangar-bridge/relay.env"
  INSTALLED_UNIT="${TEST_HOME}/.config/systemd/user/${UNIT_NAME}"
  NATS_STATE_DIR="${FIXTURE_DIR}/nats-state"
  PROC_ROOT="${FIXTURE_DIR}/proc"
  mkdir -p "${TEST_HOME}/projects" "${MOCK_BIN}" "${NATS_STATE_DIR}" "${PROC_ROOT}/4242"
  ln -s "${REPO_ROOT}" "${TEST_HOME}/projects/hangar-bridge"
  ln -s "${REPO_ROOT}" "${PROC_ROOT}/4242/cwd"
  : > "${SYSTEMCTL_LOG}"
  : > "${COREPACK_LOG}"

  cp "${SCRIPT_DIR}/hangar-bridge-relay.service" "${FIXTURE_DIR}/relay.service"

  # shellcheck disable=SC2016 # variables expand when the generated mock runs
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "%s\n" "$*" >> "${SYSTEMCTL_LOG}"' \
    'if [[ -n "${SYSTEMCTL_FAIL_MATCH:-}" && "$*" == *"${SYSTEMCTL_FAIL_MATCH}"* ]]; then exit 17; fi' \
    'if [[ "$*" == "--user restart hangar-bridge-relay.service" || "$*" == "--user enable --now hangar-bridge-relay.service" ]]; then' \
    '  [[ -f "${REVISION_FILE}" && -f "${INSTALLED_UNIT}" ]] || exit 19' \
    '  grep -q "^EnvironmentFile=%h/.config/hangar-bridge/relay.env$" "${INSTALLED_UNIT}" || exit 19' \
    'fi' \
    'if [[ "$*" == "--user is-active --quiet hangar-bridge-relay.service" ]]; then' \
    '  [[ "${RELAY_ACTIVE:-false}" == "true" ]]' \
    '  exit' \
    'fi' \
    'if [[ "$*" == "--user show --property MainPID --value hangar-bridge-relay.service" ]]; then printf "4242\n"; exit 0; fi' \
    'if [[ "$*" == "--user is-enabled "* ]]; then exit 1; fi' \
    'exit 0' \
    > "${MOCK_BIN}/systemctl"
  chmod +x "${MOCK_BIN}/systemctl"

  # shellcheck disable=SC2016 # variables expand when the generated mock runs
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'count=0' \
    'if [[ -f "${CURL_COUNT_FILE}" ]]; then read -r count < "${CURL_COUNT_FILE}"; fi' \
    'count=$((count + 1))' \
    'printf "%s\n" "${count}" > "${CURL_COUNT_FILE}"' \
    'if (( count <= ${CURL_FAILS_BEFORE_SUCCESS:-0} )); then exit 22; fi' \
    'if [[ "${CURL_HEALTHY:-true}" == "true" ]]; then' \
    '  printf "{\"ok\":true,\"build_revision\":\"%s\"}\n" "${CURL_REVISION}"' \
    '  exit 0' \
    'fi' \
    'exit 22' \
    > "${MOCK_BIN}/curl"
  chmod +x "${MOCK_BIN}/curl"

  printf '#!/usr/bin/env bash\nexit 0\n' > "${MOCK_BIN}/sleep"
  chmod +x "${MOCK_BIN}/sleep"

  printf '#!/usr/bin/env bash\nprintf "v24.16.0\\n"\n' > "${MOCK_BIN}/node"
  chmod +x "${MOCK_BIN}/node"

  # Keep installer identity checks deterministic even while this test file is
  # itself being edited. Individual regressions can inject dirty status.
  # shellcheck disable=SC2016
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [[ "$*" == *" status --porcelain --untracked-files=all" ]]; then printf "%s" "${GIT_STATUS_OUTPUT:-}"; exit 0; fi' \
    'if [[ "$*" == *" rev-parse HEAD" ]]; then printf "%s\n" "${MOCK_REVISION}"; exit 0; fi' \
    'if [[ "$*" == *" rev-parse --show-toplevel" ]]; then printf "%s\n" "${MOCK_REPO_ROOT}"; exit 0; fi' \
    'exec /usr/bin/git "$@"' \
    > "${MOCK_BIN}/git"
  chmod +x "${MOCK_BIN}/git"

  # The unit test proves the pinned build happens before deployment writes;
  # the real compilation is covered by workspace build/test gates.
  # shellcheck disable=SC2016
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "%s\n" "$*" >> "${COREPACK_LOG}"' \
    'if [[ "$*" == "pnpm@10.32.1 --version" ]]; then printf "10.32.1\n"; fi' \
    'if [[ "$*" == "pnpm@10.32.1 -r build" ]]; then mkdir -p "$(dirname -- "${RELAY_DIST_INDEX}")"; printf "mock relay build\n" > "${RELAY_DIST_INDEX}"; fi' \
    'exit 0' \
    > "${MOCK_BIN}/corepack"
  chmod +x "${MOCK_BIN}/corepack"
}

cleanup_fixture() {
  rm -rf "${FIXTURE_DIR}"
}

run_installer() {
  HOME="${TEST_HOME}" \
    PATH="${MOCK_BIN}:${PATH}" \
    SYSTEMCTL_LOG="${SYSTEMCTL_LOG}" \
    REVISION_FILE="${REVISION_FILE}" \
    INSTALLED_UNIT="${INSTALLED_UNIT}" \
    RELAY_ACTIVE="${RELAY_ACTIVE:-false}" \
    SYSTEMCTL_FAIL_MATCH="${SYSTEMCTL_FAIL_MATCH:-}" \
    CURL_HEALTHY="${CURL_HEALTHY:-true}" \
    CURL_REVISION="${CURL_REVISION:-${REVISION}}" \
    CURL_COUNT_FILE="${CURL_COUNT_FILE}" \
    CURL_FAILS_BEFORE_SUCCESS="${CURL_FAILS_BEFORE_SUCCESS:-0}" \
    COREPACK_LOG="${COREPACK_LOG}" \
    RELAY_DIST_INDEX="${RELAY_DIST_INDEX}" \
    GIT_STATUS_OUTPUT="${GIT_STATUS_OUTPUT:-}" \
    MOCK_REVISION="${REVISION}" \
    MOCK_REPO_ROOT="${REPO_ROOT}" \
    HANGAR_REPO_ROOT="${HANGAR_REPO_ROOT:-${REPO_ROOT}}" \
    PROC_ROOT="${PROC_ROOT}" \
    NATS_STATE_DIR="${NATS_STATE_DIR}" \
    bash "${INSTALLER}" --enable --revision "${REVISION}"
}

test_dirty_checkout_fails_before_build_or_deployment() {
  new_fixture
  GIT_STATUS_OUTPUT=$' M packages/relay/src/index.ts\n'

  if run_installer > "${FIXTURE_DIR}/install.out" 2>&1; then
    fail 'relay installer must reject a dirty exact-revision checkout'
  fi
  if [[ -s "${COREPACK_LOG}" ]] || deployment_writes_exist; then
    fail 'dirty checkout must fail before build or deployment writes'
  fi

  cleanup_fixture
}

test_exact_checkout_is_built_before_deployment() {
  new_fixture

  if ! run_installer > "${FIXTURE_DIR}/install.out" 2>&1; then
    fail 'clean exact checkout should build and install successfully'
  elif ! grep -Fqx 'pnpm@10.32.1 install --frozen-lockfile' "${COREPACK_LOG}" || \
    ! grep -Fqx 'pnpm@10.32.1 -r build' "${COREPACK_LOG}"; then
    fail 'installer must install and build the admitted checkout with pinned pnpm'
  fi

  cleanup_fixture
}

deployment_writes_exist() {
  [[ -e "${REVISION_FILE}" || -e "${INSTALLED_UNIT}" || \
    -e "${TEST_HOME}/.config/hangar-bridge/peers.json" ]]
}

test_with_nats_without_enable_does_not_enable_nats() {
  new_fixture

  if ! HOME="${TEST_HOME}" PATH="${MOCK_BIN}:${PATH}" \
    SYSTEMCTL_LOG="${SYSTEMCTL_LOG}" REVISION_FILE="${REVISION_FILE}" \
    INSTALLED_UNIT="${INSTALLED_UNIT}" RELAY_ACTIVE=true CURL_HEALTHY=true \
    CURL_REVISION="${REVISION}" NATS_STATE_DIR="${NATS_STATE_DIR}" \
    COREPACK_LOG="${COREPACK_LOG}" GIT_STATUS_OUTPUT="" \
    RELAY_DIST_INDEX="${RELAY_DIST_INDEX}" \
    MOCK_REVISION="${REVISION}" MOCK_REPO_ROOT="${REPO_ROOT}" \
    HANGAR_REPO_ROOT="${REPO_ROOT}" PROC_ROOT="${PROC_ROOT}" \
    bash "${INSTALLER}" --with-nats --revision "${REVISION}" \
    > "${FIXTURE_DIR}/install.out" 2>&1; then
    fail 'active relay upgrade with NATS artifacts should succeed'
    cleanup_fixture
    return
  fi
  if grep -Fqx -- '--user enable --now hangar-bridge-nats.service' "${SYSTEMCTL_LOG}"; then
    fail '--with-nats without --enable must not enable or start NATS'
  fi

  cleanup_fixture
}

test_active_service_is_restarted_on_upgrade() {
  new_fixture
  RELAY_ACTIVE=true

  if ! run_installer > "${FIXTURE_DIR}/install.out" 2>&1; then
    fail 'active relay upgrade should succeed'
    cleanup_fixture
    return
  fi

  if ! grep -Fqx -- "--user restart ${UNIT_NAME}" "${SYSTEMCTL_LOG}"; then
    fail 'active relay upgrade must restart the relay after daemon-reload'
  fi
  if grep -Fqx -- "--user enable --now ${UNIT_NAME}" "${SYSTEMCTL_LOG}"; then
    fail 'active relay upgrade must not use first-install enable --now path'
  fi

  cleanup_fixture
}

test_enable_on_active_service_enables_then_restarts() {
  new_fixture
  RELAY_ACTIVE=true

  if ! run_installer > "${FIXTURE_DIR}/install.out" 2>&1; then
    fail 'active-but-disabled relay upgrade with --enable should succeed'
    cleanup_fixture
    return
  fi

  if ! grep -Fqx -- "--user enable ${UNIT_NAME}" "${SYSTEMCTL_LOG}"; then
    fail '--enable must enable an already-active relay unit'
  fi
  if ! grep -Fqx -- "--user restart ${UNIT_NAME}" "${SYSTEMCTL_LOG}"; then
    fail 'an already-active relay must still restart to load the new build'
  fi

  cleanup_fixture
}

test_inactive_first_install_is_enabled_and_started() {
  new_fixture
  RELAY_ACTIVE=false

  if ! run_installer > "${FIXTURE_DIR}/install.out" 2>&1; then
    fail 'inactive relay first install should succeed'
    cleanup_fixture
    return
  fi

  if ! grep -Fqx -- "--user enable --now ${UNIT_NAME}" "${SYSTEMCTL_LOG}"; then
    fail 'inactive relay first install must use enable --now'
  fi

  cleanup_fixture
}

test_revision_is_written_before_service_activation() {
  new_fixture
  RELAY_ACTIVE=false

  if ! run_installer > "${FIXTURE_DIR}/install.out" 2>&1; then
    fail 'revision-aware first install should succeed'
    cleanup_fixture
    return
  fi

  if [[ ! -f "${REVISION_FILE}" ]]; then
    fail 'relay installer must create the revision EnvironmentFile'
  elif [[ "$(<"${REVISION_FILE}")" != $'HANGAR_BUILD_REVISION='"${REVISION}"$'\nPATH='"${MOCK_BIN}"':/usr/local/bin:/usr/bin:/bin' ]]; then
    fail 'relay EnvironmentFile must contain the validated revision and pinned Node path'
  fi
  if [[ -f "${REVISION_FILE}" ]] && [[ "$(stat -c '%a' "${REVISION_FILE}")" != "600" ]]; then
    fail 'relay revision EnvironmentFile must use mode 600'
  fi

  cleanup_fixture
}

test_uppercase_revision_is_normalized() {
  new_fixture
  UPPER_REVISION="${REVISION^^}"
  LOWER_REVISION="${REVISION}"

  if ! HOME="${TEST_HOME}" PATH="${MOCK_BIN}:${PATH}" \
    SYSTEMCTL_LOG="${SYSTEMCTL_LOG}" REVISION_FILE="${REVISION_FILE}" \
    INSTALLED_UNIT="${INSTALLED_UNIT}" RELAY_ACTIVE=false CURL_HEALTHY=true \
    COREPACK_LOG="${COREPACK_LOG}" GIT_STATUS_OUTPUT="" \
    RELAY_DIST_INDEX="${RELAY_DIST_INDEX}" \
    MOCK_REVISION="${REVISION}" MOCK_REPO_ROOT="${REPO_ROOT}" \
    CURL_REVISION="${LOWER_REVISION}" HANGAR_REPO_ROOT="${REPO_ROOT}" PROC_ROOT="${PROC_ROOT}" \
    bash "${INSTALLER}" --enable --revision "${UPPER_REVISION}" \
    > "${FIXTURE_DIR}/install.out" 2>&1; then
    fail 'uppercase 40-hex revision should be accepted'
    cleanup_fixture
    return
  fi
  if [[ "$(<"${REVISION_FILE}")" != $'HANGAR_BUILD_REVISION='"${LOWER_REVISION}"$'\nPATH='"${MOCK_BIN}"':/usr/local/bin:/usr/bin:/bin' ]]; then
    fail 'uppercase revision must be normalized to lowercase in the EnvironmentFile'
  fi

  cleanup_fixture
}

test_source_checkout_must_match_unit_working_directory() {
  new_fixture
  OTHER_REPO="${FIXTURE_DIR}/other-repo"
  mkdir -p "${OTHER_REPO}"

  if HOME="${TEST_HOME}" PATH="${MOCK_BIN}:${PATH}" SYSTEMCTL_LOG="${SYSTEMCTL_LOG}" \
    HANGAR_REPO_ROOT="${OTHER_REPO}" PROC_ROOT="${PROC_ROOT}" \
    bash "${INSTALLER}" --enable --revision "${REVISION}" \
    > "${FIXTURE_DIR}/install.out" 2>&1; then
    fail 'relay installer must reject a checkout different from the unit WorkingDirectory'
  fi
  if [[ -s "${SYSTEMCTL_LOG}" ]]; then
    fail 'checkout mismatch must fail before invoking systemctl'
  fi
  if [[ -e "${REVISION_FILE}" || -e "${INSTALLED_UNIT}" ]]; then
    fail 'checkout mismatch must fail before writing deployment identity or unit files'
  fi

  cleanup_fixture
}

test_source_checkout_head_must_match_requested_revision() {
  new_fixture
  OTHER_REVISION="ffffffffffffffffffffffffffffffffffffffff"
  [[ "${OTHER_REVISION}" != "${REVISION}" ]] || OTHER_REVISION="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"

  if HOME="${TEST_HOME}" PATH="${MOCK_BIN}:${PATH}" SYSTEMCTL_LOG="${SYSTEMCTL_LOG}" \
    HANGAR_REPO_ROOT="${REPO_ROOT}" PROC_ROOT="${PROC_ROOT}" \
    bash "${INSTALLER}" --enable --revision "${OTHER_REVISION}" \
    > "${FIXTURE_DIR}/install.out" 2>&1; then
    fail 'relay installer must reject a requested revision different from unit repository HEAD'
  fi
  if [[ -s "${SYSTEMCTL_LOG}" ]] || deployment_writes_exist; then
    fail 'repository HEAD mismatch must fail before writes or systemctl'
  fi

  cleanup_fixture
}

test_running_process_cwd_must_match_deployed_repo() {
  new_fixture
  OTHER_CWD="${FIXTURE_DIR}/other-cwd"
  mkdir -p "${OTHER_CWD}"
  ln -sfn "${OTHER_CWD}" "${PROC_ROOT}/4242/cwd"
  RELAY_ACTIVE=false

  if run_installer > "${FIXTURE_DIR}/install.out" 2>&1; then
    fail 'relay installer must reject a healthy process running from another checkout'
  fi
  if ! grep -q 'working directory' "${FIXTURE_DIR}/install.out"; then
    fail 'process cwd mismatch must explain the working-directory failure'
  fi

  cleanup_fixture
}

test_invalid_revision_fails_before_writes_or_systemctl() {
  new_fixture

  if HOME="${TEST_HOME}" PATH="${MOCK_BIN}:${PATH}" SYSTEMCTL_LOG="${SYSTEMCTL_LOG}" \
    bash "${INSTALLER}" --enable --revision 'not-a-40-hex-sha' \
    > "${FIXTURE_DIR}/install.out" 2>&1; then
    fail 'relay installer must reject a non-40-hex revision'
  fi
  if [[ -s "${SYSTEMCTL_LOG}" ]]; then
    fail 'invalid revision must fail before invoking systemctl'
  fi
  if deployment_writes_exist; then
    fail 'invalid revision must fail before writing deployment files'
  fi

  cleanup_fixture
}

test_missing_revision_fails_before_writes_or_systemctl() {
  new_fixture

  if HOME="${TEST_HOME}" PATH="${MOCK_BIN}:${PATH}" SYSTEMCTL_LOG="${SYSTEMCTL_LOG}" \
    bash "${INSTALLER}" --enable > "${FIXTURE_DIR}/install.out" 2>&1; then
    fail 'relay installer must require an exact revision'
  fi
  if [[ -s "${SYSTEMCTL_LOG}" ]]; then
    fail 'missing revision must fail before invoking systemctl'
  fi
  if deployment_writes_exist; then
    fail 'missing revision must fail before writing deployment files'
  fi

  cleanup_fixture
}

test_missing_revision_value_and_unknown_argument_fail_closed() {
  new_fixture

  if HOME="${TEST_HOME}" PATH="${MOCK_BIN}:${PATH}" SYSTEMCTL_LOG="${SYSTEMCTL_LOG}" \
    bash "${INSTALLER}" --revision > "${FIXTURE_DIR}/missing-value.out" 2>&1; then
    fail 'relay installer must reject --revision without a value'
  fi
  if HOME="${TEST_HOME}" PATH="${MOCK_BIN}:${PATH}" SYSTEMCTL_LOG="${SYSTEMCTL_LOG}" \
    bash "${INSTALLER}" --revision "${REVISION}" --surprise \
    > "${FIXTURE_DIR}/unknown.out" 2>&1; then
    fail 'relay installer must reject unknown arguments'
  fi
  if [[ -s "${SYSTEMCTL_LOG}" ]] || deployment_writes_exist; then
    fail 'argument validation failures must happen before writes or systemctl'
  fi

  cleanup_fixture
}

test_unsupported_node_fails_before_writes_or_systemctl() {
  new_fixture
  printf '#!/usr/bin/env bash\nprintf "v20.19.0\\n"\n' > "${MOCK_BIN}/node"
  chmod +x "${MOCK_BIN}/node"

  if HOME="${TEST_HOME}" PATH="${MOCK_BIN}:${PATH}" SYSTEMCTL_LOG="${SYSTEMCTL_LOG}" \
    bash "${INSTALLER}" --enable --revision "${REVISION}" \
    > "${FIXTURE_DIR}/install.out" 2>&1; then
    fail 'relay installer must reject Node versions below 22'
  fi
  if [[ -s "${SYSTEMCTL_LOG}" ]]; then
    fail 'unsupported Node must fail before invoking systemctl'
  fi
  if deployment_writes_exist; then
    fail 'unsupported Node must fail before writing deployment files'
  fi
  if ! grep -q 'Node.*22' "${FIXTURE_DIR}/install.out"; then
    fail 'unsupported Node failure must explain the Node 22 requirement'
  fi

  cleanup_fixture
}

test_missing_node_fails_before_writes_or_systemctl() {
  new_fixture
  NO_NODE_BIN="${FIXTURE_DIR}/no-node-bin"
  mkdir -p "${NO_NODE_BIN}"
  ln -s "$(command -v dirname)" "${NO_NODE_BIN}/dirname"
  ln -s "$(command -v jq)" "${NO_NODE_BIN}/jq"
  ln -s "$(command -v git)" "${NO_NODE_BIN}/git"
  ln -s "$(command -v grep)" "${NO_NODE_BIN}/grep"
  ln -s "$(command -v readlink)" "${NO_NODE_BIN}/readlink"
  ln -s "${MOCK_BIN}/curl" "${NO_NODE_BIN}/curl"
  ln -s "${MOCK_BIN}/systemctl" "${NO_NODE_BIN}/systemctl"

  if HOME="${TEST_HOME}" PATH="${NO_NODE_BIN}" SYSTEMCTL_LOG="${SYSTEMCTL_LOG}" \
    /usr/bin/bash "${INSTALLER}" --enable --revision "${REVISION}" \
    > "${FIXTURE_DIR}/install.out" 2>&1; then
    fail 'relay installer must reject a missing Node binary'
  fi
  if [[ -s "${SYSTEMCTL_LOG}" ]]; then
    fail 'missing Node must fail before invoking systemctl'
  fi
  if deployment_writes_exist; then
    fail 'missing Node must fail before writing deployment files'
  fi
  if ! grep -q 'Node.*22' "${FIXTURE_DIR}/install.out"; then
    fail 'missing Node failure must explain the Node 22 requirement'
  fi

  cleanup_fixture
}

test_unit_uses_installer_pinned_node_path() {
  if grep -q '^Environment=PATH=' "${SCRIPT_DIR}/hangar-bridge-relay.service"; then
    fail 'relay unit must not carry a static host-specific Node path'
  fi
  if ! grep -q '^EnvironmentFile=%h/.config/hangar-bridge/relay.env$' \
    "${SCRIPT_DIR}/hangar-bridge-relay.service"; then
    fail 'relay unit must load the installer-pinned Node path from relay.env'
  fi
}

test_help_is_read_only_and_documents_required_revision() {
  new_fixture

  if ! HOME="${TEST_HOME}" PATH="${MOCK_BIN}:${PATH}" SYSTEMCTL_LOG="${SYSTEMCTL_LOG}" \
    bash "${INSTALLER}" --help > "${FIXTURE_DIR}/help.out" 2>&1; then
    fail 'relay installer --help should succeed'
  fi
  if ! grep -q -- '--revision' "${FIXTURE_DIR}/help.out"; then
    fail 'relay installer help must document --revision'
  fi
  if [[ -s "${SYSTEMCTL_LOG}" ]] || deployment_writes_exist; then
    fail 'relay installer --help must not write or invoke systemctl'
  fi

  cleanup_fixture
}

test_systemctl_failure_propagates_without_success_claim() {
  new_fixture
  RELAY_ACTIVE=true
  SYSTEMCTL_FAIL_MATCH="restart ${UNIT_NAME}"

  if run_installer > "${FIXTURE_DIR}/install.out" 2>&1; then
    fail 'relay installer must fail when restart fails'
  fi
  if grep -q 'Restarted.*hangar-bridge-relay' "${FIXTURE_DIR}/install.out"; then
    fail 'relay installer must not claim restart success after systemctl failure'
  fi

  cleanup_fixture
}

test_failed_health_check_is_a_failed_install() {
  new_fixture
  RELAY_ACTIVE=false
  CURL_HEALTHY=false

  if run_installer > "${FIXTURE_DIR}/install.out" 2>&1; then
    fail 'relay installer must fail when the post-start health check never succeeds'
  fi
  if ! grep -q 'ERROR:.*health' "${FIXTURE_DIR}/install.out"; then
    fail 'relay installer must explain the failed health check'
  fi

  cleanup_fixture
}

test_slow_start_within_thirty_probe_budget_succeeds() {
  new_fixture
  RELAY_ACTIVE=false
  CURL_FAILS_BEFORE_SUCCESS=6

  if ! run_installer > "${FIXTURE_DIR}/install.out" 2>&1; then
    fail 'relay installer must tolerate a healthy service that needs more than five probes'
  elif [[ "$(< "${CURL_COUNT_FILE}")" != 7 ]]; then
    fail 'slow-start regression must observe six failed probes before success'
  fi

  cleanup_fixture
}

test_mismatched_health_revision_is_a_failed_install() {
  new_fixture
  RELAY_ACTIVE=false
  CURL_REVISION="ffffffffffffffffffffffffffffffffffffffff"

  if run_installer > "${FIXTURE_DIR}/install.out" 2>&1; then
    fail 'relay installer must fail when health reports a different build revision'
  fi
  if ! grep -q 'ERROR:.*revision' "${FIXTURE_DIR}/install.out"; then
    fail 'relay installer must explain the mismatched health revision'
  fi

  cleanup_fixture
}

test_start_limits_are_in_unit_section() {
  SECTIONS="$(awk '
    /^\[/ { section = $0 }
    /^StartLimit(IntervalSec|Burst)=/ { print section }
  ' "${SCRIPT_DIR}/hangar-bridge-relay.service")"

  if [[ "${SECTIONS}" != $'[Unit]\n[Unit]' ]]; then
    fail 'StartLimitIntervalSec and StartLimitBurst must be in [Unit]'
  fi
}

test_active_service_is_restarted_on_upgrade
test_dirty_checkout_fails_before_build_or_deployment
test_exact_checkout_is_built_before_deployment
test_enable_on_active_service_enables_then_restarts
test_with_nats_without_enable_does_not_enable_nats
test_inactive_first_install_is_enabled_and_started
test_revision_is_written_before_service_activation
test_uppercase_revision_is_normalized
test_source_checkout_must_match_unit_working_directory
test_source_checkout_head_must_match_requested_revision
test_running_process_cwd_must_match_deployed_repo
test_invalid_revision_fails_before_writes_or_systemctl
test_missing_revision_fails_before_writes_or_systemctl
test_missing_revision_value_and_unknown_argument_fail_closed
test_unsupported_node_fails_before_writes_or_systemctl
test_missing_node_fails_before_writes_or_systemctl
test_help_is_read_only_and_documents_required_revision
test_systemctl_failure_propagates_without_success_claim
test_failed_health_check_is_a_failed_install
test_slow_start_within_thirty_probe_budget_succeeds
test_mismatched_health_revision_is_a_failed_install
test_start_limits_are_in_unit_section
test_unit_uses_installer_pinned_node_path

if ((FAILURES > 0)); then
  printf '%d relay installer regression(s) failed.\n' "${FAILURES}" >&2
  exit 1
fi

printf 'PASS: install-relay regressions\n'
