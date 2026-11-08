#!/usr/bin/env bash
# Instala el scoreboard como servicio en Linux (Ubuntu/Debian).
# Uso:  cd scoreboard && sudo bash install.sh        (puerto 8080)
#       sudo PORT=9000 bash install.sh               (otro puerto)
set -euo pipefail

PORT="${PORT:-8080}"
DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_USER="${SUDO_USER:-$(whoami)}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecuta con sudo:  sudo bash install.sh"; exit 1
fi

# 1) Revisar que estén todos los archivos
missing=0
for f in server.js db.js pdf.js public/control.html public/display.html public/popup.html; do
  [ -f "$DIR/$f" ] || { echo "FALTA: $f"; missing=1; }
done
[ "$missing" -eq 0 ] || { echo "Copia los archivos que faltan a $DIR y vuelve a correr el script."; exit 1; }

# 2) Node.js 22 (necesario para SQLite integrado; requiere 22.13 o más nuevo)
need_node=1
if command -v node >/dev/null 2>&1; then
  v="$(node -p 'process.versions.node')"
  major="${v%%.*}"; rest="${v#*.}"; minor="${rest%%.*}"
  if [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 13 ]; }; then need_node=0; fi
  echo "Node encontrado: v$v"
fi
if [ "$need_node" -eq 1 ]; then
  if command -v apt-get >/dev/null 2>&1; then
    echo "Instalando Node.js 22..."
    apt-get update
    apt-get install -y ca-certificates curl
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  else
    echo "No hay apt-get. Instala Node.js 22.13+ a mano (https://nodejs.org) y vuelve a correr el script."; exit 1
  fi
fi
NODE_BIN="$(command -v node)"
echo "Usando $NODE_BIN ($("$NODE_BIN" -v))"

chown -R "$RUN_USER":"$RUN_USER" "$DIR"

# 3) Servicio systemd: arranca solo al encender la PC y se reinicia si falla
cat > /etc/systemd/system/scoreboard.service <<EOF
[Unit]
Description=Scoreboard (HTTP + WebSocket)
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$DIR
Environment=PORT=$PORT
ExecStart=$NODE_BIN $DIR/server.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable scoreboard
systemctl restart scoreboard

# 4) Firewall (solo si ufw está activo)
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow "$PORT"/tcp
fi

sleep 2
IP="$(hostname -I | awk '{print $1}')"
echo
if systemctl is-active --quiet scoreboard; then
  echo "Scoreboard funcionando."
else
  echo "El servicio no arrancó. Revisa:  journalctl -u scoreboard -n 50"; exit 1
fi
echo "  Mesa / operador: http://$IP:$PORT/control.html"
echo "  Pantalla (OBS):  http://$IP:$PORT/display.html"
echo "  Rótulos (OBS):   http://$IP:$PORT/popup.html"
