#!/bin/bash
# Respaldo diario de los scoreboards: base de datos (copia segura aunque el servidor esté corriendo)
# + imágenes subidas (logos, fondos, fotos). Guarda los últimos 30 días en ~/respaldos-scoreboard.
# Se instala con cron (ver README, sección Respaldos). Para correrlo a mano: ~/respaldos-scoreboard/respaldo.sh
set -u
DEST="$HOME/respaldos-scoreboard"
KEEP_DAYS=30
STAMP=$(date +%F_%H%M)
NODE=$(command -v node || echo /usr/bin/node)
mkdir -p "$DEST"

# respaldar <nombre> <carpeta del proyecto> <base de datos (relativa)> [carpetas de imágenes (relativas)...]
respaldar() {
  local name=$1 dir=$2 db=$3; shift 3
  if [ ! -f "$dir/$db" ]; then echo "$(date '+%F %T') $name: no existe $dir/$db (se omite)"; return; fi
  local tmp; tmp=$(mktemp -d)
  # VACUUM INTO hace una copia consistente sin detener el servicio
  if ! "$NODE" --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    new DatabaseSync(process.argv[1], { readOnly: true }).exec("VACUUM INTO " + JSON.stringify(process.argv[2]).replace(/"/g, "\x27"));
  ' "$dir/$db" "$tmp/scoreboard.db"; then
    echo "$(date '+%F %T') $name: ERROR al copiar la base de datos"; rm -rf "$tmp"; return 1
  fi
  local extra=()
  for d in "$@"; do [ -d "$dir/$d" ] && extra+=("$d"); done
  local out="$DEST/$name-$STAMP.tar.gz"
  if tar -czf "$out" -C "$tmp" scoreboard.db ${extra[@]+-C "$dir" "${extra[@]}"}; then
    echo "$(date '+%F %T') $name: OK $(du -h "$out" | cut -f1) -> $out"
  else
    echo "$(date '+%F %T') $name: ERROR al comprimir"
  fi
  rm -rf "$tmp"
}

respaldar baloncesto "$HOME/scoreboard/SCOREBOARDBASKETBALLADS/scoreboard" scoreboard.db public/logos public/bg
respaldar beisbol "$HOME/baseball-scoreboard/scoreboard-beisbol" data/scoreboard.db data/uploads

# borrar respaldos de más de KEEP_DAYS días
find "$DEST" -name '*.tar.gz' -mtime +"$KEEP_DAYS" -print -delete | sed "s/^/$(date '+%F %T') borrado viejo: /"
