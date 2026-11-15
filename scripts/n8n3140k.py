import io, traceback, paramiko
PW='9856#Edrafox'; KEY=open('k/hml').read()
def conn(h,u='root'):
    k=paramiko.Ed25519Key.from_private_key(io.StringIO(KEY)); c=paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(h,22,username=u,pkey=k,password=PW,timeout=25,banner_timeout=40,auth_timeout=40,allow_agent=False,look_for_keys=False); return c
def run(c,cmd,t=400):
    ch=c.get_transport().open_session(); ch.settimeout(t); ch.exec_command(cmd); b=[]
    try:
        while True:
            d=ch.recv(65536)
            if not d: break
            b.append(d.decode('utf-8','replace'))
            if sum(len(x) for x in b)>150000: break
    except Exception as e: b.append('\n[RUNEXC %s]\n'%type(e).__name__)
    return ''.join(b)
D='/etc/easypanel/projects/n8n/n8n/volumes/data'
C=[('akia-live','timeout 300 grep -aoE ".{60}(AKIA|ASIA)[0-9A-Z]{16}.{140}" %s/database.sqlite | head -10'%D,330),
   ('akia-backup','timeout 240 grep -aoE ".{60}(AKIA|ASIA)[0-9A-Z]{16}.{140}" /root/n8n-backup/database.sqlite | head -10',270),
   ('exec-data','timeout 200 grep -aoE ".{40}(amazonaws\\.com|X-Amz-Credential).{140}" %s/database.sqlite | sort -u | head -10'%D,230)]
c=conn('69.62.100.163')
try:
    for l,cmd,t in C:
        print('----- %s -----'%l,flush=True); print(run(c,cmd,t),flush=True)
finally: c.close()
