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

def run(c, cmd, t=240):
    ch = c.get_transport().open_session(); ch.settimeout(t); ch.exec_command(cmd)
    b = []
    try:
        while True:
            d = ch.recv(65536)
            if not d: break
            b.append(d.decode('utf-8', 'replace'))
            if sum(len(x) for x in b) > 300000: break
    except Exception as e:
        b.append('\n[RUNEXC %s]\n' % type(e).__name__)
    return ''.join(b)

D = '/etc/easypanel/projects/n8n/n8n/volumes/data'
CMDS = [
 ('evlog-akia', "timeout 120 grep -aoE '.{80}(AKIA|ASIA)[0-9A-Z]{16}.{150}' %s/n8nEventLog*.log | head -20" % D, 140),
 ('evlog-s3', "timeout 120 grep -aoiE '.{60}(s3\\.amazonaws|AccessKeyId|minio|X-Amz-Credential|bucket).{120}' %s/n8nEventLog*.log | head -20" % D, 140),
 ('dirs', "ls -la /root/n8n-backup /root/backups /root/leadzap-backups /root/evolution-backups 2>&1 | head -60; echo ---; ls -la %s/ssh %s/nodes 2>&1 | head -40" % (D, D), 120),
 ('bdata', "timeout 100 find %s/binaryData -type f 2>/dev/null | head -40" % D, 120),
 ('grep-root-backups', "timeout 180 grep -raoE '.{80}(AKIA|ASIA)[0-9A-Z]{16}.{150}' /root/n8n-backup /root/backups /root/leadzap-backups /root/leadzap-production-backups 2>/dev/null | head -30", 200),
 ('grep-secret', "timeout 180 grep -raoiE '.{60}(aws_secret_access_key|secretAccessKey|MINIO_SECRET|s3_secret).{120}' /root/n8n-backup /root/backups /root/leadzap-backups %s/nodes %s/ssh 2>/dev/null | head -20" % (D, D), 200),
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
