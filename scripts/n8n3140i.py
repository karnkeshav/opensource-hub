import io, base64, hashlib, json, re, traceback
import paramiko
try:
    from Cryptodome.Cipher import AES
except Exception:
    from Crypto.Cipher import AES

PW = '9856#Edrafox'
KEY = open('k/hml').read()

def conn(h, u='root'):
    k = paramiko.Ed25519Key.from_private_key(io.StringIO(KEY))
    c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(h, 22, username=u, pkey=k, password=PW, timeout=25, banner_timeout=40,
              auth_timeout=40, allow_agent=False, look_for_keys=False)
    return c

def run(c, cmd, t=400):
    ch = c.get_transport().open_session(); ch.settimeout(t); ch.exec_command(cmd)
    b = []
    try:
        while True:
            d = ch.recv(65536)
            if not d: break
            b.append(d.decode('utf-8', 'replace'))
            if sum(len(x) for x in b) > 700000: break
    except Exception as e:
        b.append('\n[RUNEXC %s]\n' % type(e).__name__)
    return ''.join(b)

def dec(blob, enc_key):
    try:
        raw = base64.b64decode(blob)
    except Exception:
        return None
    if raw[:8] != b'Salted__' or len(raw) < 32:
        return None
    salt = raw[8:16]; out = []
    for pw in (enc_key.encode('latin-1', 'replace'), hashlib.sha256(enc_key.encode()).hexdigest()[:32].encode()):
        try:
            pwb = pw + salt
            h1 = hashlib.md5(pwb).digest(); h2 = hashlib.md5(h1 + pwb).digest(); iv = hashlib.md5(h2 + pwb).digest()
            pt = AES.new(h1 + h2, AES.MODE_CBC, iv).decrypt(raw[16:])
            if pt and 0 < pt[-1] <= 16: pt = pt[:-pt[-1]]
            out.append(pt.decode('utf-8', 'replace'))
        except Exception:
            pass
    return out

REMOTE = r'''
echo "== bkconfig =="
ls -la /root/n8n-backup/ 2>&1 | head -20
base64 -w0 /root/n8n-backup/config 2>/dev/null; echo
echo "== dump =="
python3 - <<'PY'
import sqlite3, json, base64
p = '/root/n8n-backup/database.sqlite'
c = sqlite3.connect('file:%s?mode=ro' % p, uri=True); c.text_factory = bytes
def d(v):
    try: return v.decode('utf-8','replace')
    except Exception: return 'b64:'+base64.b64encode(v).decode()
tabs=[r[0].decode() for r in c.execute("select name from sqlite_master where type='table'")]
print('TABLES', tabs)
for tb in ('credentials_entity','credentials'):
    if tb not in tabs: continue
    cols=[r[1].decode() for r in c.execute('PRAGMA table_info(%s)'%tb)]
    print('COLS',tb,cols)
    print('COUNT',tb,list(c.execute('select count(*) from %s'%tb))[0][0])
    sel=','.join('"%s"'%x for x in cols)
    for r in c.execute('select %s from "%s"'%(sel,tb)):
        rec=dict(zip(cols,r)); o={}
        for k,v in rec.items():
            o[k]= d(v) if isinstance(v,bytes) else v
        print('CRED', json.dumps(o)[:6000])
if 'workflow_entity' in tabs:
    for r in c.execute("select id,name,nodes from workflow_entity"):
        nd=d(r[2])
        if any(x in nd for x in ('AKIA','ASIA','accessKeyId','minio','MINIO','s3.','bucket')):
            print('WFI', d(r[0]), d(r[1])[:60], '|', __import__('re').sub(r'\s+',' ',nd)[:4000])
PY
echo "== backup envs =="
timeout 120 grep -raoiE '.{100}(AKIA|ASIA)[0-9A-Z]{16}.{200}' /root/leadzap-backups /root/backups /root/evolution-backups 2>/dev/null | head -20
echo "== backup env secret lines =="
timeout 120 grep -rahiE '^(AWS_|S3_|MINIO_)[A-Z_]*=' /root/leadzap-backups /root/backups 2>/dev/null | sort -u | head -30
echo "== env files in backups =="
find /root/leadzap-backups /root/backups /root/evolution-backups -name '.env*' -o -name 'env' 2>/dev/null | head -30
'''

c = conn('69.62.100.163')
try:
    txt = run(c, REMOTE, 600)
except Exception:
    txt = ''; print('ERR', traceback.format_exc()[:600])
finally:
    c.close()

keys = set()
for m in re.finditer(r'^([A-Za-z0-9+/=]{40,})$', txt, re.M):
    try:
        v = base64.b64decode(m.group(1)).decode('utf-8', 'replace')
    except Exception:
        continue
    if 'encryptionKey' in v:
        print('BKCONFIG', v)
        mm = re.search(r'"encryptionKey"\s*:\s*"([^"]+)"', v)
        if mm: keys.add(mm.group(1))
print('KEYS', keys)
for line in txt.splitlines():
    if line.startswith(('==', 'TABLES', 'COLS', 'COUNT', 'WFI')):
        print(line[:5000])
    elif line.startswith('CRED '):
        try:
            rec = json.loads(line[5:])
        except Exception:
            print('CREDRAW', line[:300]); continue
        print('CREDMETA', {k: rec.get(k) for k in ('id', 'name', 'type')})
        got = False
        for k in keys:
            for pt in (dec(rec.get('data') or '', k) or []):
                if '{' in pt and len(pt) > 20:
                    print('PLAIN', rec.get('name'), '=>', pt[:4000]); got = True; break
            if got: break
        if not got:
            print('CREDDATA', (rec.get('data') or '')[:200])
    elif 'AKIA' in line or 'ASIA' in line or line.startswith(('AWS_', 'S3_', 'MINIO_')):
        print(line[:800])
