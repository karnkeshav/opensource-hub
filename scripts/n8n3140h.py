import io, traceback
import paramiko

PW = '9856#Edrafox'
KEY = open('k/hml').read()

def conn(h, u='root'):
    k = paramiko.Ed25519Key.from_private_key(io.StringIO(KEY))
    c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(h, 22, username=u, pkey=k, password=PW, timeout=25, banner_timeout=40,
              auth_timeout=40, allow_agent=False, look_for_keys=False)
    return c

def run(c, cmd, t=200):
    ch = c.get_transport().open_session(); ch.settimeout(t); ch.exec_command(cmd)
    b = []
    try:
        while True:
            d = ch.recv(65536)
            if not d: break
            b.append(d.decode('utf-8', 'replace'))
            if sum(len(x) for x in b) > 200000: break
    except Exception as e:
        b.append('\n[RUNEXC %s]\n' % type(e).__name__)
    return ''.join(b)

PAT = r'.{300}(AKIA|ASIA)[0-9A-Z]{16}.{300}'
S = [
 ('sql-dumps', "ls -la /srv/backups/leadzap/*/ 2>&1 | head -20; timeout 120 grep -aoE '%s' /srv/backups/leadzap/*/database.sql 2>/dev/null | head -10" % PAT, 150),
 ('sql-gz', "for f in /srv/backups/leadzap/*/*.gz; do echo \"## $f\"; timeout 180 zcat \"$f\" 2>/dev/null | grep -aoE '%s' | head -6; done" % PAT, 220),
 ('all-sql', "timeout 200 find /srv /root /home -name '*.sql' -o -name '*.sql.gz' 2>/dev/null | head -60", 220),
 ('grep-allsql', "for f in $(timeout 60 find /srv /root /home -name '*.sql' 2>/dev/null | head -40); do timeout 30 grep -aoE '%s' \"$f\" 2>/dev/null | head -4; done" % PAT, 240),
 ('atl', "ls -la /srv/edra/.atlas-backups 2>&1 | head -30; for f in /srv/edra/.atlas-backups/*; do echo \"## $f\"; timeout 60 grep -aoE '%s' \"$f\" 2>/dev/null | head -5; done" % PAT, 200),
 ('archives', "timeout 60 find /srv /root /home -type f \\( -name '*.tar.gz' -o -name '*.tgz' -o -name '*.zip' -o -name '*.bak' \\) 2>/dev/null | head -60", 100),
 ('arch-grep', "for f in $(timeout 60 find /srv /root /home -type f \\( -name '*.tar.gz' -o -name '*.tgz' -o -name '*.zip' -o -name '*.bak' \\) 2>/dev/null | head -25); do echo \"## $f\"; case \"$f\" in *.zip) timeout 60 unzip -p \"$f\" 2>/dev/null | grep -aoE '%s' | head -4;; *) timeout 60 zcat \"$f\" 2>/dev/null | grep -aoE '%s' | head -4;; esac; done" % (PAT, PAT), 300),
 ('hist', "for f in /root/.bash_history /home/*/.bash_history /root/.git/config /root/.aws/credentials /root/.aws/config /home/*/.aws/credentials /home/*/.git/config; do [ -f \"$f\" ] && { echo \"## $f\"; timeout 20 grep -aoiE '.{120}(AKIA|ASIA|aws_secret|secretAccessKey).{160}' \"$f\" | head -6; }; done", 150),
 ('gj', "timeout 90 find / -maxdepth 5 -name '.git' -type d 2>/dev/null | head -10; timeout 60 grep -aoiE '.{80}(AKIA|ASIA|aws_secret).{160}' /root/n8n-backup/* 2>/dev/null | head -10", 160),
]

c = conn('69.62.100.163')
try:
    for label, cmd, t in S:
        print('----- %s -----' % label, flush=True)
        print(run(c, cmd, t), flush=True)
except Exception:
    print('ERR', traceback.format_exc()[:600])
finally:
    c.close()
