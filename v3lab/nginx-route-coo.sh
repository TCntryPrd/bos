#!/usr/bin/env bash
# Route the web container's /api/coo/ (IR Custom AIOS Chat) to the v3 engine on the host (:8090),
# leaving all other /api/* on the legacy api. SSE-friendly (no buffering).
set -e
CONF=$(docker exec boss_web sh -c 'ls /etc/nginx/conf.d/*.conf 2>/dev/null | head -1')
[ -z "$CONF" ] && CONF=/etc/nginx/conf.d/default.conf
docker cp "boss_web:$CONF" /tmp/web.conf
python3 - "$@" <<'PY'
f='/tmp/web.conf'; s=open(f).read()
block='''    location /api/coo/ {
        proxy_pass http://host.docker.internal:8090/api/coo/;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }
'''
if '/api/coo/' in s:
    print('already routed')
else:
    s=s.replace('    location /api/ {', block+'    location /api/ {', 1)
    open(f,'w').write(s); print('inserted /api/coo route')
PY
docker cp /tmp/web.conf "boss_web:$CONF"
docker exec boss_web nginx -t && docker exec boss_web nginx -s reload && echo "nginx reloaded"
