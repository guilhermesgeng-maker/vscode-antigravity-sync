#!/usr/bin/env python3
"""Read Antigravity (Gemini / Argon / Astra) and Codex SQLite token usage.

Antigravity keeps each conversation in ~/.gemini/antigravity/conversations/<id>.db (and
~/.gemini/antigravity-ide/conversations/<id>.db). The `steps` table stores one protobuf blob per
step; a step that made a model call carries a usage block whose fields were identified by
cross-checking against the parallel `gen_metadata` table:

    (1,1)  unix seconds for the step
    (9,2)  input tokens        (9,5)  cached input tokens
    (9,3)  output tokens       (9,9)  thinking tokens   (9,10) response tokens  [9+10 == 3]
    (19,)  model name

Older conversations (*.pb files) are encrypted and carry no readable usage.
Emits the same bucket rows the JS collector uses, as JSON on stdout.
"""
import base64, datetime, glob, json, os, re, sqlite3, struct, sys, time, urllib.parse

BUCKET_MS = 10 * 60 * 1000


def read_varint(b, i):
    shift = result = 0
    while True:
        x = b[i]
        i += 1
        result |= (x & 0x7F) << shift
        shift += 7
        if not x & 0x80:
            return result, i


def parse(b, depth=0):
    """Minimal protobuf wire-format walk: yields (path, value) for scalars and strings."""
    out = []
    i = 0
    while i < len(b):
        try:
            key, i = read_varint(b, i)
            field, wire = key >> 3, key & 7
            if wire == 0:
                v, i = read_varint(b, i)
                out.append((field, v))
            elif wire == 1:
                out.append((field, int.from_bytes(b[i:i + 8], 'little')))
                i += 8
            elif wire == 2:
                n, i = read_varint(b, i)
                chunk = b[i:i + n]
                i += n
                try:
                    text = chunk.decode('utf-8')
                    printable = all(32 <= ord(c) < 127 for c in text)
                except Exception:
                    printable = False
                if printable:
                    out.append((field, text))
                elif depth < 4 and chunk:
                    out.append((field, parse(chunk, depth + 1)))
            elif wire == 5:
                out.append((field, int.from_bytes(b[i:i + 4], 'little')))
                i += 4
            else:
                return out
        except Exception:
            return out
    return out


def flatten(items, path=()):
    for field, value in items:
        cur = path + (field,)
        if isinstance(value, list):
            yield from flatten(value, cur)
        else:
            yield cur, value


def project_map(roots):
    """conversation id -> workspace folder name, from the summaries databases."""
    out = {}
    for root in roots:
        db = os.path.join(root, 'conversation_summaries.db')
        if not os.path.exists(db):
            continue
        try:
            con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
            for cid, title, uris in con.execute('select conversation_id, title, workspace_uris from conversation_summaries'):
                try:
                    paths = json.loads(uris or '[]')
                except Exception:
                    paths = []
                if paths:
                    unquoted = urllib.parse.unquote(paths[0].rstrip('/'))
                    out[cid] = os.path.basename(unquoted) or unquoted
                elif title and cid not in out:
                    out[cid] = title
            con.close()
        except Exception:
            pass
    return out


def read_local_limits(active_models=None):
    """Read cached plan, email, and per-model quotaInfo from Antigravity's local state."""
    email = None
    appdata = os.environ.get('APPDATA')
    home = os.path.expanduser('~')
    app_storage_candidates = []
    if appdata:
        app_storage_candidates.append(os.path.join(appdata, 'Antigravity', 'app_storage.json'))
    app_storage_candidates.extend([
        os.path.join(home, 'Library/Application Support/Antigravity/app_storage.json'),
        os.path.join(home, '.config/Antigravity/app_storage.json'),
    ])
    for p in app_storage_candidates:
        if os.path.exists(p):
            try:
                with open(p, encoding='utf-8') as f:
                    st = json.load(f)
                u = st.get('jetski.onboarding.lastLoginUsername')
                if isinstance(u, str) and '@' in u:
                    email = u
                    break
            except Exception:
                pass

    candidates = []
    if appdata:
        for app in ('Antigravity IDE', 'Antigravity'):
            candidates.append(os.path.join(appdata, app, 'User', 'globalStorage', 'state.vscdb'))
    for rel in (
        'Library/Application Support/Antigravity IDE/User/globalStorage/state.vscdb',
        '.config/Antigravity IDE/User/globalStorage/state.vscdb',
    ):
        candidates.append(os.path.join(home, rel))

    for db_path in candidates:
        if not os.path.exists(db_path):
            continue
        try:
            con = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
            row = con.execute(
                "SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.userStatus'"
            ).fetchone()
            credits_row = con.execute(
                "SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.modelCredits'"
            ).fetchone()
            con.close()
            if not row or not row[0]:
                continue
            outer = dict(flatten(parse(base64.b64decode(row[0]))))
            inner_b64 = outer.get((1, 2, 1))
            if not isinstance(inner_b64, str):
                continue
            inner = parse(base64.b64decode(inner_b64), depth=0)
            plan = None
            credits = None
            if credits_row and credits_row[0]:
                try:
                    c_outer = dict(flatten(parse(base64.b64decode(credits_row[0]))))
                    c_b64 = c_outer.get((1, 2, 1))
                    if isinstance(c_b64, str):
                        c_inner = dict(flatten(parse(base64.b64decode(c_b64))))
                        if isinstance(c_inner.get((2,)), int):
                            credits = c_inner.get((2,))
                except Exception:
                    pass
            models = {}
            default_gemini_quota = {'remainingFraction': 1.0, 'resetTime': '1970-01-01T00:00:00Z'}
            for field, val in inner:
                if field == 7 and isinstance(val, str) and '@' in val and not email:
                    email = val
                elif field == 36 and isinstance(val, list):
                    d36 = dict(flatten(val))
                    plan = d36.get((2,)) or d36.get((1,))
                    if credits is None and isinstance(d36.get((14, 3)), int):
                        credits = d36.get((14, 3))
                elif field == 33 and isinstance(val, list):
                    for sub_field, sub_val in val:
                        if sub_field == 1 and isinstance(sub_val, list):
                            d = dict(flatten(sub_val))
                            label = d.get((1,))
                            if not isinstance(label, str) or not label:
                                continue
                            slug = label.lower().replace('(', '').replace(')', '').replace(' ', '-')
                            raw_rem = d.get((15, 1))
                            if isinstance(raw_rem, int):
                                rem = struct.unpack('<f', struct.pack('<I', raw_rem))[0]
                            else:
                                rem = 1.0
                            reset_sec = d.get((15, 2, 1))
                            if isinstance(reset_sec, int) and reset_sec > 0:
                                reset_iso = datetime.datetime.fromtimestamp(
                                    reset_sec, tz=datetime.timezone.utc
                                ).isoformat().replace('+00:00', 'Z')
                            else:
                                reset_iso = '1970-01-01T00:00:00Z'
                            qinfo = {
                                'remainingFraction': max(0.0, min(1.0, float(rem))),
                                'resetTime': reset_iso,
                            }
                            models[slug] = {
                                'displayName': label,
                                'quotaInfo': qinfo,
                            }
                            if slug.startswith('gemini') or 'argon' in slug or 'astra' in slug:
                                default_gemini_quota = dict(qinfo)
            # Ensure active Argon / Astra / Gemini models from conversations are represented in the pool
            if active_models:
                for m in active_models:
                    low = m.lower()
                    if (low.startswith('gemini') or 'argon' in low or 'astra' in low) and low not in models:
                        models[low] = {
                            'displayName': m,
                            'quotaInfo': dict(default_gemini_quota),
                        }
            if models or plan or email:
                return {'plan': plan, 'email': email, 'credits': credits, 'models': models}
        except Exception:
            continue
    return {'plan': None, 'email': email, 'credits': None, 'models': {}} if email else None


def collect_codex_sqlite_buckets(codex_home, cutoff_ms):
    """Read Codex turn token usage from logs_2.sqlite for threads not stored as rollout files."""
    buckets = {}
    logs_db = os.path.join(codex_home, 'logs_2.sqlite')
    if not os.path.exists(logs_db):
        return []

    # Find thread IDs already present in sessions/ rollout files to avoid double-counting
    rollout_threads = set()
    sessions_dir = os.path.join(codex_home, 'sessions')
    if os.path.isdir(sessions_dir):
        for root_dir, _dirs, files in os.walk(sessions_dir):
            for fname in files:
                if fname.endswith('.jsonl') or fname.endswith('.jsonl.zst'):
                    m = re.search(r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', fname)
                    if m:
                        rollout_threads.add(m.group(1))

    # Map thread_id -> project name from state_5.sqlite if available
    thread_projects = {}
    state_db = os.path.join(codex_home, 'state_5.sqlite')
    if os.path.exists(state_db):
        try:
            con = sqlite3.connect(f'file:{state_db}?mode=ro', uri=True)
            for tid, cwd in con.execute('SELECT id, cwd FROM threads'):
                if tid and cwd:
                    clean_cwd = cwd.replace('\\\\?\\', '').rstrip('/\\')
                    thread_projects[tid] = os.path.basename(clean_cwd) or clean_cwd
            con.close()
        except Exception:
            pass

    try:
        con = sqlite3.connect(f'file:{logs_db}?mode=ro', uri=True)
        rows = con.execute(
            "SELECT ts, thread_id, feedback_log_body FROM logs "
            "WHERE target = 'codex_core::session::turn' AND feedback_log_body LIKE '%total_usage_tokens=%' "
            "ORDER BY id"
        ).fetchall()
        con.close()
    except Exception:
        return []

    prev_turn_tokens = {}
    for ts, thread_id, body in rows:
        if not isinstance(ts, int):
            continue
        ts_ms = ts * 1000
        if ts_ms < cutoff_ms:
            continue
        if thread_id and thread_id in rollout_threads:
            continue
        m_model = re.search(r'model=([^\s}]+)', body)
        m_tok = re.search(r'total_usage_tokens=(\d+)', body)
        m_turn = re.search(r'turn_id=([^\s}]+)', body)
        if not m_tok:
            continue
        total_tok = int(m_tok.group(1))
        model = m_model.group(1) if m_model else 'unknown'
        turn_key = (thread_id or '', m_turn.group(1) if m_turn else '')
        prev = prev_turn_tokens.get(turn_key, 0)
        delta = total_tok - prev if total_tok >= prev else total_tok
        prev_turn_tokens[turn_key] = total_tok
        if delta <= 0:
            continue
        project = thread_projects.get(thread_id, 'Codex')
        start = int(ts_ms // BUCKET_MS) * BUCKET_MS
        key = (start, model, project)
        row = buckets.setdefault(key, [start, model, project, 0, 0, 0, 0, 0, 0])
        # Approximate split when only total_usage_tokens is logged (first step is uncached input, subsequent steps mostly cached)
        if prev == 0:
            inp = int(delta * 0.95)
            cached = 0
            out = delta - inp
        else:
            cached = int(prev * 0.95)
            inp = max(0, int(delta * 0.85))
            out = max(0, delta - inp)
        row[3] += inp
        row[4] += cached
        row[6] += out
        row[8] += 1

    return list(buckets.values())


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/.gemini/antigravity')
    lookback_days = float(sys.argv[2]) if len(sys.argv) > 2 else 90
    codex_home = sys.argv[3] if len(sys.argv) > 3 else os.path.expanduser('~/.codex')
    cutoff_ms = (time.time() - lookback_days * 86400) * 1000

    roots = [root]
    alt_root = os.path.join(os.path.dirname(root.rstrip('/\\')), 'antigravity-ide')
    if os.path.isdir(alt_root) and os.path.abspath(alt_root) != os.path.abspath(root):
        roots.append(alt_root)

    projects = project_map(roots)
    buckets = {}
    active_models = set()

    db_by_cid = {}
    for r in roots:
        for db_path in glob.glob(os.path.join(r, 'conversations', '*.db')):
            cid = os.path.splitext(os.path.basename(db_path))[0]
            try:
                mtime = os.path.getmtime(db_path)
            except Exception:
                mtime = 0
            if cid not in db_by_cid or mtime > db_by_cid[cid][0]:
                db_by_cid[cid] = (mtime, db_path)

    for cid, (_mtime, db_path) in db_by_cid.items():
        project = projects.get(cid, 'unknown')
        try:
            con = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
            rows = con.execute('select idx, metadata from steps where metadata is not null order by idx').fetchall()
            # Model names live in the parallel gen_metadata blobs. Its idx counts model calls while
            # steps.idx counts every step, so the two line up by order, not by index. Match on the
            # input-token count (which both record) and fall back to position.
            gen_models, gen_by_input = [], {}
            try:
                for _gidx, blob in con.execute('select idx, data from gen_metadata where data is not null order by idx'):
                    gflat = dict(flatten(parse(blob)))
                    name = gflat.get((1, 19)) or gflat.get((3, 28)) or gflat.get((1, 21))
                    if not isinstance(name, str) or not name:
                        name = None
                    gen_models.append(name)
                    tokens = gflat.get((1, 17, 2, 2)) or gflat.get((1, 4, 2))
                    if name and isinstance(tokens, int):
                        gen_by_input[tokens] = name
            except Exception:
                pass
            con.close()
        except Exception:
            continue
        call_number = 0
        for step_idx, meta in rows:
            if not meta:
                continue
            flat = dict(flatten(parse(meta)))
            usage = {k[1]: v for k, v in flat.items() if len(k) == 2 and k[0] == 9 and isinstance(v, int)}
            if not usage or not (usage.get(2) or usage.get(3) or usage.get(5)):
                continue
            seconds = flat.get((1, 1))
            if not isinstance(seconds, int) or seconds < 1_000_000_000:
                continue
            ts = seconds * 1000
            if ts < cutoff_ms:
                continue
            model = flat.get((19,))
            if not isinstance(model, str) or not model:
                model = gen_by_input.get(usage.get(2))
            if not model and call_number < len(gen_models):
                model = gen_models[call_number]
            if not model and gen_models:
                model = gen_models[-1]
            call_number += 1
            if not isinstance(model, str) or not model:
                model = 'unknown'
            active_models.add(model)
            start = int(ts // BUCKET_MS) * BUCKET_MS
            key = (start, model, project)
            row = buckets.setdefault(key, [start, model, project, 0, 0, 0, 0, 0, 0])
            row[3] += usage.get(2, 0)          # input
            row[4] += usage.get(5, 0)          # cached input
            row[6] += usage.get(3, 0)          # output
            row[7] += usage.get(9, 0)          # thinking
            row[8] += 1

    codex_extra_buckets = collect_codex_sqlite_buckets(codex_home, cutoff_ms)
    json.dump({
        'buckets': list(buckets.values()),
        'codexSqliteBuckets': codex_extra_buckets,
        'limits': read_local_limits(active_models)
    }, sys.stdout)


if __name__ == '__main__':
    main()
