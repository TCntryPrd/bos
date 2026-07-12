#!/bin/bash
# System info script — called by IR Custom AIOS API to get host system status
# Returns JSON to stdout

echo "{"

# Hostname and OS
echo "\"hostname\": \"$(hostname)\","
echo "\"os\": \"$(lsb_release -ds 2>/dev/null || cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"')\","
echo "\"kernel\": \"$(uname -r)\","
echo "\"uptime\": \"$(uptime -p)\","
echo "\"load\": \"$(cat /proc/loadavg | awk '{print $1, $2, $3}')\","

# CPU
echo "\"cpu\": \"$(grep 'model name' /proc/cpuinfo | head -1 | cut -d: -f2 | xargs)\","
echo "\"cpu_cores\": $(nproc),"

# Memory
TOTAL=$(free -m | awk '/Mem:/ {print $2}')
USED=$(free -m | awk '/Mem:/ {print $3}')
echo "\"memory_total_mb\": $TOTAL,"
echo "\"memory_used_mb\": $USED,"
echo "\"memory_pct\": $(echo "scale=1; $USED * 100 / $TOTAL" | bc),"

# Disk
DISK=$(df -h / | awk 'NR==2 {print $2 "|" $3 "|" $4 "|" $5}')
echo "\"disk_total\": \"$(echo $DISK | cut -d'|' -f1)\","
echo "\"disk_used\": \"$(echo $DISK | cut -d'|' -f2)\","
echo "\"disk_avail\": \"$(echo $DISK | cut -d'|' -f3)\","
echo "\"disk_pct\": \"$(echo $DISK | cut -d'|' -f4)\","

# Docker
echo "\"docker_containers\": $(docker ps --format json 2>/dev/null | python3 -c "
import sys, json
containers = []
for line in sys.stdin:
    c = json.loads(line.strip())
    containers.append({'name': c.get('Names',''), 'status': c.get('Status',''), 'image': c.get('Image','')})
print(json.dumps(containers))
" 2>/dev/null || echo '[]'),"

# Updates available
UPDATES=$(apt list --upgradable 2>/dev/null | grep -c 'upgradable' || echo 0)
echo "\"updates_available\": $UPDATES,"

# Tailscale
echo "\"tailscale_ip\": \"$(tailscale ip -4 2>/dev/null || echo 'unknown')\","
echo "\"tailscale_hostname\": \"$(tailscale status --self --json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('Self',{}).get('DNSName','unknown'))" 2>/dev/null || echo 'unknown')\""

echo "}"
