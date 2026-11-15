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

def run(c, cmd, t=300):
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

M = "M=$(docker ps -q --filter name=minio | head -1);"
CMDS = [
 ('minio-all', M + " docker exec $M sh -c 'mc alias set l http://127.0.0.1:9000 admin 98562523Edra >/dev/null 2>&1; echo BUCKETS; mc ls l; echo ALL; mc ls -r l; echo ANON; mc anonymous get l/bucketimg 2>&1; echo DU; mc du l 2>&1' 2>&1 | head -60", 180),
 ('bdump', M + " docker exec $M sh -c 'mc cat l/bucketimg/* 2>/dev/null' | strings | head -20", 180),
 ('totalmei', "for u in 'https://totalmei.com.s3.sa-east-1.amazonaws.com/?list-type=2' 'https://s3.sa-east-1.amazonaws.com/totalmei.com/?list-type=2' 'https://totalmei.com.s3.amazonaws.com/?list-type=2' 'https://totalmei.com.s3.sa-east-1.amazonaws.com/?acl'; do echo \"## $u\"; curl -s -m 20 -w '[%{http_code}]' \"$u\" | head -c 400; echo; done", 120),
 ('keynames', "timeout 200 grep -aoE 'totalmei\\.com/[A-Za-z0-9._/%-]{1,120}' /etc/easypanel/projects/n8n/n8n/volumes/data/database.sqlite | sort -u | head -40", 240),
]

c = conn('69.62.100.163')
try:
    for label, cmd, t in CMDS:
        print('----- %s -----' % label, flush=True)
        print(run(c, cmd, t), flush=True)
except Exception:
    print('ERR', traceback.format_exc()[:600])
finally:
    c.close()
