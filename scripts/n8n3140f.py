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

def run(c, cmd, t=600):
    ch = c.get_transport().open_session(); ch.settimeout(t); ch.exec_command(cmd)
    b = []
    try:
        while True:
            d = ch.recv(65536)
            if not d: break
            b.append(d.decode('utf-8', 'replace'))
            if sum(len(x) for x in b) > 800000: break
    except Exception as e:
        b.append('\n[RUNEXC %s]\n' % type(e).__name__)
    return ''.join(b)

CMDS = r'''
M=$(docker ps -q --filter name=minio | head -1)
echo "M=$M"
docker port $M 2>&1 | head
echo "== alias+lsls =="
docker exec $M sh -c 'mc alias set l http://127.0.0.1:9000 admin 98562523Edra; mc ls l; echo ---REC---; mc ls -r l' 2>&1 | head -200
echo "== objsizes =="
docker exec $M sh -c 'mc ls -r l --json' 2>/dev/null | head -200
echo "== hostports =="
ss -ltnp 2>/dev/null | grep -E ':900[0-9]' | head
echo "== n8n dirs =="
ls -la /etc/easypanel/projects/n8n/n8n/volumes/data/.n8n 2>&1 | head -40
ls -la /etc/easypanel/projects/n8n/n8n/volumes/data 2>&1 | head -40
echo "== backups =="
find / -maxdepth 4 -type d \( -name '*backup*' -o -name 'backups' \) 2>/dev/null | grep -v -E '^/(proc|sys)' | head -30
echo "== grep n8ndir =="
grep -raoE '.{80}(AKIA|ASIA)[0-9A-Z]{16}.{120}' /etc/easypanel/projects/n8n/n8n/volumes/data/.n8n /etc/easypanel/projects/n8n/n8n/code 2>/dev/null | head -20
grep -raoiE '.{60}(secretAccessKey|aws_secret|MINIO_PASS|s3AccessKey).{100}' /etc/easypanel/projects/n8n 2>/dev/null | head -20
echo "== setting s3 =="
D=$(docker ps -q --filter name=evolution-api-db | head -1)
docker exec $D psql -U postgres -d n8n -Atc 'select "instanceId", key, left(value::text,400) from "Setting" where key ilike $$%s3%$$ or key ilike $$%minio%$$ or key ilike $$%bucket%$$ limit 30' 2>&1 | tail -20
docker exec $D psql -U postgres -d n8n -Atc 'select name from "Instance" limit 20' 2>&1 | tail -10
'''

c = conn('69.62.100.163')
try:
    print(run(c, CMDS, 700))
except Exception:
    print('ERR', traceback.format_exc()[:600])
finally:
    c.close()
