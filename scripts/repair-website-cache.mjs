#!/usr/bin/env node

import { existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const mode = process.argv[2] || 'inspect'
if (!['inspect', 'apply', 'canonical-inspect'].includes(mode)) throw new Error('Mode must be inspect, apply, or canonical-inspect.')

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function readSshConfig() {
  const host = String(process.env.WORKWISE_WEBSITE_SSH_HOST || '').trim()
  const port = String(process.env.WORKWISE_WEBSITE_SSH_PORT || '').trim()
  const user = String(process.env.WORKWISE_WEBSITE_SSH_USER || '').trim()
  const keyPath = resolve(String(process.env.WORKWISE_WEBSITE_SSH_KEY_PATH || ''))
  const knownHostsPath = resolve(String(process.env.WORKWISE_WEBSITE_SSH_KNOWN_HOSTS_PATH || ''))
  if (!host || !port || !user || !existsSync(keyPath) || !existsSync(knownHostsPath)) {
    throw new Error('Website SSH configuration is incomplete.')
  }
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) && !/^[A-Za-z0-9.-]+$/.test(host)) {
    throw new Error('Invalid website SSH host.')
  }
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('Invalid website SSH port.')
  }
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(user)) throw new Error('Invalid website SSH user.')
  for (const path of [keyPath, knownHostsPath]) {
    if (!statSync(path).isFile()) throw new Error(`SSH path is not a file: ${path}`)
  }
  return { host, port, user, keyPath, knownHostsPath }
}

function runRemote(config) {
  const remote = `bash -s -- ${shellQuote(mode)}`
  return execFileSync(
    'ssh',
    [
      '-p', config.port,
      '-i', config.keyPath,
      '-o', 'BatchMode=yes',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${config.knownHostsPath}`,
      `${config.user}@${config.host}`,
      remote
    ],
    { input: REMOTE_SCRIPT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  )
}

function validateDiagnostics(output) {
  const diagnostics = new Map()
  for (const line of String(output).split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    diagnostics.set(line.slice(0, separator), line.slice(separator + 1))
  }
  const required = [
    'nginx_binary',
    'nginx_config_test',
    'railwise_server_config',
    'target_server_name_count',
    'workwise_cache_rule_count',
    'legacy_cache_rule_count',
    'server_7d_cache_directive_count'
  ]
  const missing = required.filter((key) => !diagnostics.has(key))
  if (missing.length) {
    throw new Error(`Remote cache inspection returned incomplete diagnostics: ${missing.join(', ')}`)
  }
  if (diagnostics.get('nginx_binary') === 'missing') {
    throw new Error('Remote cache inspection did not locate nginx or OpenResty.')
  }
  if (diagnostics.get('nginx_config_test') !== 'passed') {
    throw new Error('Remote nginx/OpenResty configuration test did not pass.')
  }
  if (diagnostics.get('railwise_server_config') === 'missing') {
    throw new Error('Remote cache inspection did not locate the railwise.cn server configuration.')
  }
  return output
}

function validateCanonicalDiagnostics(output) {
  const diagnostics = new Map()
  for (const line of String(output).split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    diagnostics.set(line.slice(0, separator), line.slice(separator + 1))
  }
  const required = ['canonical_status', 'canonical_server_file', 'canonical_effective_root', 'canonical_route_legacy', 'canonical_route_canonical']
  const missing = required.filter((key) => !diagnostics.has(key))
  if (missing.length) throw new Error(`Remote canonical inspection returned incomplete diagnostics: ${missing.join(', ')}`)
  if (!['passed', 'blocked'].includes(diagnostics.get('canonical_status'))) {
    throw new Error(`Remote canonical inspection returned invalid status: ${diagnostics.get('canonical_status')}`)
  }
  return output
}

const REMOTE_SCRIPT = String.raw`set -euo pipefail
mode="$1"
target_host='www.railwise.cn'

run_privileged() {
  case "$privilege_mode" in
    root) "$@" ;;
    sudo) sudo -n "$@" ;;
    *) "$@" ;;
  esac
}

privilege_mode=unavailable
if [[ "$(id -u)" == 0 ]]; then
  privilege_mode=root
elif sudo -n true 2>/dev/null; then
  privilege_mode=sudo
fi

nginx_bin=""
nginx_candidate_count=0
host_candidate_matches() {
  local candidate="$1"
  [[ -n "$candidate" ]] || return 1
  if ! { [[ -x "$candidate" ]] || run_privileged test -x "$candidate" 2>/dev/null; }; then
    return 1
  fi
  if ! run_privileged "$candidate" -t >/dev/null 2>&1; then
    return 1
  fi
  ((nginx_candidate_count += 1))
  run_privileged "$candidate" -T 2>&1 \
    | grep -Eiq 'server_name[^;]*[[:space:]]www[.]railwise[.]cn([[:space:]]|;)'
}

if command -v ps >/dev/null 2>&1; then
  while IFS= read -r candidate; do
    if host_candidate_matches "$candidate"; then
      nginx_bin="$candidate"
      break
    fi
  done < <(ps -eo args= | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^\/.+\/(nginx|openresty)$/) print $i }' | sort -u)
fi
if [[ -z "$nginx_bin" ]] && command -v pgrep >/dev/null 2>&1 && command -v readlink >/dev/null 2>&1; then
  for process_name in nginx openresty; do
    while IFS= read -r pid; do
      candidate="$(run_privileged readlink -f "/proc/$pid/exe" 2>/dev/null || true)"
      if host_candidate_matches "$candidate"; then
        nginx_bin="$candidate"
        break 2
      fi
    done < <(pgrep -x "$process_name" || true)
  done
fi
for candidate in \
  openresty nginx \
  /usr/sbin/nginx /usr/local/sbin/nginx /usr/local/nginx/sbin/nginx \
  /usr/local/openresty/bin/openresty /usr/local/openresty/nginx/sbin/nginx \
  /opt/openresty/bin/openresty /opt/openresty/nginx/sbin/nginx \
  /opt/nginx/sbin/nginx /www/server/nginx/sbin/nginx \
  /opt/1panel/apps/openresty/openresty/bin/openresty \
  /opt/1panel/apps/openresty/openresty/nginx/sbin/nginx \
  /opt/1panel/apps/nginx/nginx/sbin/nginx; do
  [[ -n "$nginx_bin" ]] && break
  if [[ "$candidate" == */* ]]; then
    if host_candidate_matches "$candidate"; then
      nginx_bin="$candidate"
      break
    fi
  else
    resolved="$(command -v "$candidate" || true)"
    if host_candidate_matches "$resolved"; then
      nginx_bin="$resolved"
      break
    fi
  fi
done

nginx_container=""
container_user_flag=""
if [[ -z "$nginx_bin" ]] && command -v docker >/dev/null 2>&1; then
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    for process_name in nginx openresty; do
      candidate_user_flag=""
      candidate="$(docker exec -u 0 "$container" sh -c "command -v $process_name" 2>/dev/null || true)"
      if [[ -z "$candidate" ]]; then
        candidate="$(docker exec "$container" sh -c "command -v $process_name" 2>/dev/null || true)"
        [[ -n "$candidate" ]] || continue
      else
        candidate_user_flag='-u 0'
      fi
      if docker exec $candidate_user_flag "$container" "$candidate" -t >/dev/null 2>&1; then
        ((nginx_candidate_count += 1))
      else
        continue
      fi
      if docker exec $candidate_user_flag "$container" "$candidate" -T 2>&1 \
        | grep -Eiq 'server_name[^;]*[[:space:]]www[.]railwise[.]cn([[:space:]]|;)'; then
        nginx_container="$container"
        nginx_bin="$candidate"
        container_user_flag="$candidate_user_flag"
        break 2
      fi
    done
  done < <(docker ps --format '{{.Names}}' 2>/dev/null || true)
fi

server_run() {
  if [[ -n "$nginx_container" ]]; then
    docker exec $container_user_flag "$nginx_container" "$@"
  else
    run_privileged "$@"
  fi
}

server_write_file() {
  local destination="$1"
  if [[ -n "$nginx_container" ]]; then
    docker exec $container_user_flag -i "$nginx_container" tee "$destination" >/dev/null
  else
    run_privileged tee "$destination" >/dev/null
  fi
}

server_file_exists() {
  server_run test -f "$1" 2>/dev/null
}

if [[ -z "$nginx_bin" ]]; then
  printf '%s\n' 'nginx_binary=missing'
  printf 'privilege_mode=%s\n' "$privilege_mode"
  printf 'nginx_candidate_count=%s\n' "$nginx_candidate_count"
  if command -v ps >/dev/null 2>&1; then
    printf 'server_processes='
    ps -eo comm= | awk '/^(nginx|openresty|caddy|httpd|apache2|traefik)$/ { print }' | sort -u | paste -sd, -
    printf '\n'
    printf 'server_process_args=\n'
    ps -eo args= | awk '/(nginx|openresty)/ { print }' | head -20
  fi
  if command -v systemctl >/dev/null 2>&1; then
    printf 'running_web_units='
    systemctl list-units --type=service --state=running --no-legend --no-pager 2>/dev/null \
      | awk '$1 ~ /(nginx|openresty|caddy|httpd|apache|traefik)/ { print $1 }' \
      | sort -u | paste -sd, -
    printf '\n'
  fi
  exit 2
fi

dump="$(mktemp)"
trap 'rm -f -- "$dump"' EXIT
if ! server_run "$nginx_bin" -T >"$dump" 2>&1; then
  printf 'nginx_binary=%s\nnginx_config_test=failed\n' "$(basename "$nginx_bin")"
  exit 3
fi

server_file="$(python3 - "$dump" <<'PY'
import pathlib
import re
import sys

target_host = 'www.railwise.cn'
current = ''
for raw in pathlib.Path(sys.argv[1]).read_text(errors='replace').splitlines():
    if raw.startswith('# configuration file '):
        current = raw.removeprefix('# configuration file ').removesuffix(':').strip()
    match = re.search(r'\bserver_name\b([^;]*);', raw, re.I)
    if current and match and target_host in match.group(1).split():
        print(current)
        break
PY
)"
if [[ -z "$server_file" ]] || ! server_file_exists "$server_file"; then
  printf 'nginx_binary=%s\nnginx_config_test=passed\nrailwise_server_config=missing\n' "$(basename "$nginx_bin")"
  exit 4
fi

if [[ "$mode" == canonical-inspect ]]; then
  # This branch is deliberately read-only. It inventories only the active
  # vhost's two product routes and statically reads bounded PHP source bytes;
  # it never evaluates PHP, follows an unapproved path, or prints config.
  if ! command -v python3 >/dev/null 2>&1; then
    printf 'canonical_status=blocked\ncanonical_server_file=%s\ncanonical_effective_root=unknown\n' "$(basename "$server_file")"
    printf 'canonical_route_legacy={"resolution":"blocked","reason":"missing_python3"}\n'
    printf 'canonical_route_canonical={"resolution":"blocked","reason":"missing_python3"}\n'
    exit 0
  fi

  canonical_server_config="$(mktemp)"
  canonical_plan="$(mktemp)"
  canonical_cleanup="$(mktemp)"
  trap 'rm -f -- "$dump" "$canonical_server_config" "$canonical_plan" "$canonical_cleanup"' EXIT
  if ! server_run cat -- "$server_file" >"$canonical_server_config"; then
    printf 'canonical_status=blocked\ncanonical_server_file=%s\ncanonical_effective_root=unknown\n' "$(basename "$server_file")"
    printf 'canonical_route_legacy={"resolution":"blocked","reason":"server_config_unreadable"}\n'
    printf 'canonical_route_canonical={"resolution":"blocked","reason":"server_config_unreadable"}\n'
    exit 0
  fi

  python3 - "$dump" "$canonical_server_config" >"$canonical_plan" <<'PY'
import json
import pathlib
import re
import sys

TARGET = 'www.railwise.cn'
REQUESTS = {'legacy': '/products/workwise/', 'canonical': '/products/railwise-ai/'}

def closing_brace(text, opening):
    depth = 0
    quote = ''
    comment = False
    for index in range(opening, len(text)):
        char = text[index]
        if comment:
            if char == '\n': comment = False
            continue
        if quote:
            if char == quote and (index == 0 or text[index - 1] != '\\'): quote = ''
            continue
        if char == '#': comment = True
        elif char in "'\"": quote = char
        elif char == '{': depth += 1
        elif char == '}':
            depth -= 1
            if depth == 0: return index
    return -1

def clean(value):
    value = re.sub(r'[\x00-\x1f\x7f]', ' ', str(value)).strip()
    if value.lower().startswith('return '):
        value = value.split('?', 1)[0]
    return value[:256]

def remove_nested_blocks(text):
    output = []
    cursor = 0
    for match in re.finditer(r'(?m)^\s*location\b[^\n{]*\{', text):
        if match.start() < cursor: continue
        opening = text.find('{', match.start(), match.end())
        closing = closing_brace(text, opening)
        if closing < 0: continue
        output.append(text[cursor:match.start()])
        cursor = closing + 1
    output.append(text[cursor:])
    return ''.join(output)

def directives(text):
    values = {}
    for match in re.finditer(r'(?m)^\s*(root|alias|return|rewrite|try_files|fastcgi_pass)\s+([^;]+);', text, re.I):
        values[match.group(1).lower()] = clean(match.group(2))
    script = re.search(r'(?m)^\s*fastcgi_param\s+SCRIPT_FILENAME\s+([^;]+);', text, re.I)
    if script: values['scriptFilename'] = clean(script.group(1))
    return values

def server_body(text):
    starts = list(re.finditer(r'(?m)^\s*server\s*\{', text, re.I))
    for match in starts:
        opening = text.find('{', match.start(), match.end())
        closing = closing_brace(text, opening)
        if closing < 0: continue
        body = text[opening + 1:closing]
        names = re.search(r'(?m)^\s*server_name\s+([^;]+);', body, re.I)
        if names and TARGET in names.group(1).split(): return body
    return ''

def static_path(value):
    value = str(value or '').strip()
    if not value or '$' in value or not value.startswith('/') or '..' in value.split('/'):
        return None
    if not re.fullmatch(r'/[A-Za-z0-9._/~+:-]+', value) or '//' in value: return None
    return value.rstrip('/') or '/'

dump = pathlib.Path(sys.argv[1]).read_text(errors='replace')
body = server_body(dump)
server_only = remove_nested_blocks(body)
server_directives = directives(server_only)
server_root = static_path(server_directives.get('root'))

def make_plan(label, request):
    locations = []
    for match in re.finditer(r'(?m)^\s*location\s+(?:(=|\^~|~\*?|@)\s+)?([^\s{]+)\s*\{', body, re.I):
        modifier = match.group(1) or ''
        path = clean(match.group(2))
        opening = text_body_open = body.find('{', match.start(), match.end())
        closing = closing_brace(body, opening)
        if closing < 0: continue
        if modifier.startswith('~') or modifier == '@': continue
        if modifier == '=' and path != request: continue
        if modifier != '=' and not request.startswith(path): continue
        locations.append((1 if modifier == '=' else 0, len(path), modifier, path, body[opening + 1:closing]))
    chosen = sorted(locations, reverse=True)[0] if locations else None
    if not chosen:
        return {'requestPath': request, 'location': None, 'modifier': '', 'directives': {}, 'effectiveRoot': server_root, 'resolution': 'unknown', 'reason': 'no_matching_location'}
    _, _, modifier, path, location_body = chosen
    found = directives(location_body)
    result = {'requestPath': request, 'location': path, 'modifier': modifier, 'directives': found, 'effectiveRoot': server_root}
    if 'return' in found:
        result.update(resolution='redirect', redirect=clean(found['return']).split('?', 1)[0])
        return result
    configured = found.get('scriptFilename') or found.get('alias') or found.get('root') or server_root
    if not configured or '$' in configured:
        result.update(resolution='unknown', reason='dynamic_or_missing_script_path')
        return result
    configured = static_path(configured)
    if not configured:
        result.update(resolution='blocked', reason='unsafe_script_path')
        return result
    if 'scriptFilename' in found:
        candidate = configured
    elif 'alias' in found:
        alias = configured
        if alias.endswith('/') or path.endswith('/'):
            suffix = request[len(path):] if request.startswith(path) else ''
            candidate = (alias.rstrip('/') + '/' + suffix.lstrip('/')).rstrip('/') + '/index.php'
        else:
            candidate = alias
    else:
        candidate = configured.rstrip('/') + request + 'index.php'
    candidate = static_path(candidate)
    if not candidate:
        result.update(resolution='blocked', reason='unsafe_resolved_path')
        return result
    result.update(resolution='candidate', path=candidate)
    return result

print(json.dumps({'effectiveRoot': server_root, 'routes': {label: make_plan(label, request) for label, request in REQUESTS.items()}}, separators=(',', ':')))
PY

  canonical_effective_root="$(python3 - "$canonical_plan" <<'PY'
import json, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text()).get('effectiveRoot')
print(value or 'unknown')
PY
)"

  canonical_file_facts() {
    local candidate="$1"
    local approved="$2"
    if [[ -z "$candidate" || "$candidate" == *$'\n'* || ! "$candidate" =~ ^/[A-Za-z0-9._/~+:-]+$ || "$candidate" =~ // || "$candidate" == *'/../'* || "$candidate" == */.. ]]; then
      printf '{"resolution":"blocked","reason":"unsafe_path","path":null,"realpath":null,"fileType":null,"sha256":null}'
      return
    fi
    if [[ -z "$approved" || "$approved" == unknown ]]; then
      printf '{"resolution":"unknown","reason":"unknown_approved_root","path":"%s","realpath":null,"fileType":null,"sha256":null}' "$candidate"
      return
    fi
    case "$candidate" in
      "$approved"|"$approved"/*) ;;
      *) printf '{"resolution":"blocked","reason":"outside_approved_root","path":"%s","realpath":null,"fileType":null,"sha256":null}' "$candidate"; return ;;
    esac
    if ! server_run test -e "$candidate" 2>/dev/null; then
      printf '{"resolution":"unknown","reason":"path_not_found","path":"%s","realpath":null,"fileType":null,"sha256":null}' "$candidate"
      return
    fi
    local real type sha approved_real
    real="$(server_run readlink -f -- "$candidate" 2>/dev/null | tr -d '\n' || true)"
    approved_real="$(server_run readlink -f -- "$approved" 2>/dev/null | tr -d '\n' || true)"
    case "$real" in
      "$approved_real"|"$approved_real"/*) ;;
      *) printf '{"resolution":"blocked","reason":"symlink_outside_approved_root","path":"%s","realpath":null,"fileType":null,"sha256":null}' "$candidate"; return ;;
    esac
    type="$(server_run stat -c '%F' -- "$candidate" 2>/dev/null | tr -d '\n' || true)"
    sha=""
    if [[ "$type" == 'regular file' ]]; then sha="$(server_run sha256sum -- "$candidate" 2>/dev/null | awk '{print $1}' | tr -d '\n' || true)"; fi
    python3 - "$candidate" "$real" "$type" "$sha" <<'PY'
import json, sys
print(json.dumps({'resolution': 'resolved', 'path': sys.argv[1], 'realpath': sys.argv[2], 'fileType': sys.argv[3] or 'unknown', 'sha256': sys.argv[4] or None}, separators=(',', ':')))
PY
  }

  canonical_route_json() {
    local label="$1"
    python3 - "$canonical_plan" "$label" <<'PY'
import json, pathlib, sys
print(json.dumps(json.loads(pathlib.Path(sys.argv[1]).read_text())['routes'][sys.argv[2]], separators=(',', ':')))
PY
  }

  canonical_php_json() {
    local route_json="$1"
    local approved="$2"
    local route_path
    route_path="$(python3 - "$route_json" <<'PY'
import json, sys
value = json.loads(sys.argv[1])
print(value.get('path') or '')
PY
)"
    if [[ -z "$route_path" || "$route_path" != *.php ]]; then
      printf '{"staticOnly":true,"status":"not_applicable","references":[],"versionMarkers":[]}'
      return
    fi
    local source
    source="$(mktemp)"
    if ! server_run head -c 131072 -- "$route_path" >"$source" 2>/dev/null; then
      rm -f -- "$source"
      printf '{"staticOnly":true,"status":"unknown","reason":"php_source_unreadable","references":[],"versionMarkers":[]}'
      return
    fi
    local php_json
    php_json="$(python3 - "$source" "$route_path" "$approved" <<'PY'
import json, pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text(errors='replace')[:131072]
php_path = pathlib.Path(sys.argv[2])
approved = sys.argv[3]
base = php_path.parent
refs, seen = [], set()
def add(expression, path, status):
    key = (expression, path, status)
    if key not in seen:
        seen.add(key); refs.append({'expression': expression[:256], 'path': path, 'status': status})
def safe(path):
    value = str(path)
    if not value.startswith('/') or '$' in value or '..' in value.split('/') or not re.fullmatch(r'/[A-Za-z0-9._/~+:-]+', value) or '//' in value: return None
    return value.rstrip('/') or '/'
pattern = re.compile(r'\b(?:require|require_once|include|include_once)\s*(?:\(\s*)?([^;\n]+?)(?:\s*\))?\s*;')
for match in pattern.finditer(text):
    expression = match.group(1).strip()
    joined = re.fullmatch(r'__DIR__\s*\.\s*([\'\"])([^\'\"]+)\1', expression)
    literal = re.fullmatch(r'([\'\"])([^\'\"]+)\1', expression)
    if joined: path = safe(str(base / joined.group(2).lstrip('/')))
    elif literal and literal.group(2).startswith('/'): path = safe(literal.group(2))
    else: path = None
    status = 'resolved' if path and (path == approved or path.startswith(approved.rstrip('/') + '/')) else ('blocked' if path else 'unknown')
    add(expression, path, status)
for match in re.finditer(r'__DIR__\s*\.\s*([\'\"])([^\'\"]+\.(?:php|json))\1', text):
    path = safe(str(base / match.group(2).lstrip('/')))
    status = 'resolved' if path and (path == approved or path.startswith(approved.rstrip('/') + '/')) else ('blocked' if path else 'unknown')
    add('__DIR__ . ' + match.group(1) + match.group(2) + match.group(1), path, status)
markers = []
for match in re.finditer(r'(?:version|softwareVersion|releaseVersion|releaseCommit)\s*[\'\"]?\s*(?:=>|:|=)\s*[\'\"]([^\'\"]+)[\'\"]', text, re.I): markers.append(match.group(1)[:128])
print(json.dumps({'staticOnly': True, 'status': 'passed', 'references': refs, 'versionMarkers': sorted(set(markers))}, separators=(',', ':')))
PY
)"
    rm -f -- "$source"
    local ref_count index ref_path ref_facts merged
    ref_count="$(python3 - "$php_json" <<'PY'
import json, sys
print(len(json.loads(sys.argv[1]).get('references', [])))
PY
)"
    for ((index = 0; index < ref_count; index += 1)); do
      ref_path="$(python3 - "$php_json" "$index" <<'PY'
import json, sys
value = json.loads(sys.argv[1])['references'][int(sys.argv[2])]
print(value.get('path') or '')
PY
)"
      [[ -n "$ref_path" ]] || continue
      ref_facts="$(canonical_file_facts "$ref_path" "$approved")"
      php_json="$(python3 - "$php_json" "$index" "$ref_facts" <<'PY'
import json, sys
document = json.loads(sys.argv[1]); index = int(sys.argv[2]); facts = json.loads(sys.argv[3])
document['references'][index]['facts'] = facts
print(json.dumps(document, separators=(',', ':')))
PY
)"
    done
    printf '%s' "$php_json"
  }

  printf 'canonical_status=passed\ncanonical_server_file=%s\ncanonical_effective_root=%s\n' "$(basename "$server_file")" "$canonical_effective_root"
  for label in legacy canonical; do
    route_json="$(canonical_route_json "$label")"
    route_resolution="$(python3 - "$route_json" <<'PY'
import json, sys
print(json.loads(sys.argv[1]).get('resolution', 'unknown'))
PY
)"
    route_path="$(python3 - "$route_json" <<'PY'
import json, sys
print(json.loads(sys.argv[1]).get('path') or '')
PY
)"
    if [[ "$route_resolution" == candidate && -n "$route_path" ]]; then
      facts="$(canonical_file_facts "$route_path" "$canonical_effective_root")"
      route_json="$(python3 - "$route_json" "$facts" <<'PY'
import json, sys
route = json.loads(sys.argv[1]); facts = json.loads(sys.argv[2])
route.update(facts)
if facts.get('resolution') != 'resolved': route['resolution'] = facts.get('resolution', 'unknown')
print(json.dumps(route, separators=(',', ':')))
PY
)"
      php_json="$(canonical_php_json "$route_json" "$canonical_effective_root")"
      route_json="$(python3 - "$route_json" "$php_json" <<'PY'
import json, sys
route = json.loads(sys.argv[1]); route['phpInspection'] = json.loads(sys.argv[2])
print(json.dumps(route, separators=(',', ':')))
PY
)"
    fi
    printf 'canonical_route_%s=%s\n' "$label" "$route_json"
    if [[ "$route_json" == *'"phpInspection"'* ]]; then
      printf 'canonical_php_%s=%s\n' "$label" "$(python3 - "$route_json" <<'PY'
import json, sys
print(json.dumps(json.loads(sys.argv[1]).get('phpInspection', {}), separators=(',', ':')))
PY
)"
    else
      printf 'canonical_php_%s={"staticOnly":true,"status":"not_applicable","references":[],"versionMarkers":[]}\n' "$label"
    fi
  done
  exit 0
fi

marker='# WorkWise updater metadata cache policy v2 begin'
rule_count="$(server_run grep -F -c "$marker" "$server_file" || true)"
legacy_rule_count="$(server_run grep -E -c '^[[:space:]]*# WorkWise updater metadata cache policy[[:space:]]*$' "$server_file" || true)"
target_server_name_count="$(server_run grep -Ei -c 'server_name[^;]*[[:space:]]www[.]railwise[.]cn([[:space:]]|;)' "$server_file" || true)"
expires_7d_count="$(server_run grep -E -c 'expires[[:space:]]+\+?7d|max-age[[:space:]]*=[[:space:]]*604800' "$server_file" || true)"
printf 'nginx_binary=%s\nnginx_config_test=passed\nrailwise_server_config=%s\ntarget_server_name_count=%s\nworkwise_cache_rule_count=%s\nlegacy_cache_rule_count=%s\nserver_7d_cache_directive_count=%s\n' \
  "$(basename "$nginx_bin")" "$(basename "$server_file")" "$target_server_name_count" "$rule_count" "$legacy_rule_count" "$expires_7d_count"

if [[ "$mode" == inspect ]]; then
  exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' 'apply=blocked_missing_python3'
  exit 6
fi

if [[ "$rule_count" == 1 && "$legacy_rule_count" == 0 ]]; then
  printf '%s\n' 'apply=already_present'
else
  backup="$server_file.workwise-cache-backup.$(date -u +%Y%m%dT%H%M%SZ)"
  config_temp="$server_file.workwise-cache-edit.$$"
  edit_file="$(mktemp)"
  trap 'rm -f -- "$dump" "$edit_file"' EXIT
  server_run cp -p -- "$server_file" "$backup"
  server_run cat "$server_file" >"$edit_file"
  python3 - "$edit_file" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()
target_host = 'www.railwise.cn'
server_name = next((
    match for match in re.finditer(r'(?m)^\s*server_name\b([^;]*);', text, re.I)
    if target_host in match.group(1).split()
), None)
if server_name is None:
    raise SystemExit('www.railwise.cn server_name was not found in the selected config')
server_blocks = list(re.finditer(r'(?m)^\s*server\s*\{', text[:server_name.start()]))
if not server_blocks:
    raise SystemExit('railwise server block was not found')
server_start = server_blocks[-1].start()
server_open = text.find('{', server_start, server_blocks[-1].end())

def closing_brace(source, opening):
    depth = 0
    quote = ''
    comment = False
    for index in range(opening, len(source)):
        char = source[index]
        if comment:
            if char == '\n': comment = False
            continue
        if quote:
            if char == quote and source[index - 1] != '\\': quote = ''
            continue
        if char == '#':
            comment = True
        elif char in ("'", '"'):
            quote = char
        elif char == '{':
            depth += 1
        elif char == '}':
            depth -= 1
            if depth == 0:
                return index
    raise SystemExit('railwise server block closing brace was not found')

server_close = closing_brace(text, server_open)
server_body = text[server_open + 1:server_close]

begin_marker = '# WorkWise updater metadata cache policy v2 begin'
end_marker = '# WorkWise updater metadata cache policy v2 end'
while begin_marker in server_body:
    begin = server_body.index(begin_marker)
    end = server_body.find(end_marker, begin)
    if end < 0:
        raise SystemExit('managed cache policy end marker was not found')
    end = server_body.find('\n', end)
    server_body = server_body[:begin] + server_body[len(server_body) if end < 0 else end + 1:]

legacy_marker = '# WorkWise updater metadata cache policy'
while legacy_marker in server_body:
    marker_index = server_body.index(legacy_marker)
    location = re.search(r'(?m)^\s*location\b[^\{]*\{', server_body[marker_index:])
    if location is None:
        raise SystemExit('legacy managed cache location was not found')
    location_start = marker_index + location.start()
    location_end = marker_index + location.end()
    location_open = server_body.find('{', location_start, location_end)
    location_close = closing_brace(server_body, location_open)
    end = server_body.find('\n', location_close)
    marker_line_start = server_body.rfind('\n', 0, marker_index) + 1
    server_body = server_body[:marker_line_start] + server_body[len(server_body) if end < 0 else end + 1:]

location = '''
    # WorkWise updater metadata cache policy v2 begin
    location = /downloads/workwise/channels/stable/latest/latest.json {
        expires off;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        add_header Pragma "no-cache" always;
        add_header X-Content-Type-Options "nosniff" always;
        try_files $uri =404;
    }
    location = /downloads/workwise/channels/stable/latest/latest.yml {
        expires off;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        add_header Pragma "no-cache" always;
        add_header X-Content-Type-Options "nosniff" always;
        try_files $uri =404;
    }
    location = /downloads/workwise/channels/stable/latest/latest-mac.yml {
        expires off;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        add_header Pragma "no-cache" always;
        add_header X-Content-Type-Options "nosniff" always;
        try_files $uri =404;
    }
    location = /downloads/workwise/channels/frontier/latest/latest.json {
        expires off;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        add_header Pragma "no-cache" always;
        add_header X-Content-Type-Options "nosniff" always;
        try_files $uri =404;
    }
    location = /downloads/workwise/channels/frontier/latest/latest.yml {
        expires off;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        add_header Pragma "no-cache" always;
        add_header X-Content-Type-Options "nosniff" always;
        try_files $uri =404;
    }
    location = /downloads/workwise/channels/frontier/latest/latest-mac.yml {
        expires off;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        add_header Pragma "no-cache" always;
        add_header X-Content-Type-Options "nosniff" always;
        try_files $uri =404;
    }
    location ^~ /downloads/workwise/acceptance/ {
        expires off;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        add_header Pragma "no-cache" always;
        add_header X-Content-Type-Options "nosniff" always;
        try_files $uri =404;
    }
    # WorkWise updater metadata cache policy v2 end
'''
path.write_text(text[:server_open + 1] + location + server_body + text[server_close:])
PY
  server_run cp -p -- "$server_file" "$config_temp"
  server_write_file "$config_temp" <"$edit_file"
  server_run mv -f -- "$config_temp" "$server_file"
  if ! server_run "$nginx_bin" -t; then
    server_run cp -p -- "$backup" "$server_file"
    server_run "$nginx_bin" -t
    printf 'apply=rolled_back\nbackup=%s\n' "$(basename "$backup")"
    exit 5
  fi
  if ! server_run "$nginx_bin" -s reload; then
    server_run cp -p -- "$backup" "$server_file"
    server_run "$nginx_bin" -t
    server_run "$nginx_bin" -s reload
    printf 'apply=rolled_back_reload_failed\nbackup=%s\n' "$(basename "$backup")"
    exit 7
  fi
  printf 'apply=applied\nbackup=%s\n' "$(basename "$backup")"
fi
`

const rawDiagnostics = runRemote(readSshConfig())
const diagnostics = mode === 'canonical-inspect' ? validateCanonicalDiagnostics(rawDiagnostics) : validateDiagnostics(rawDiagnostics)
process.stdout.write(`[repair-website-cache] validated remote diagnostics\n${diagnostics}`)
