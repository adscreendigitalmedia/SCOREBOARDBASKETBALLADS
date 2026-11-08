# Scoreboard con WebSocket (OBS → NDI → Resolume)

Sin instalar nada con npm. Solo necesitas **Node.js 22.13 o más nuevo** (https://nodejs.org). Con un Node más viejo todo funciona igual, pero guarda en `data.json` en vez de SQLite.

## Archivos
```
scoreboard/
  server.js        servidor HTTP + WebSocket, relojes, comandos
  db.js            base de datos SQLite (scoreboard.db) con respaldo a JSON
  pdf.js           generador del resumen del juego en PDF
  public/
    control.html   panel de la mesa / operador
    display.html   la pantalla (para OBS)
    popup.html     rótulos de anotación (para OBS, capa aparte)
    logos/         pon aquí los logos (ej. ponce.png)
```

## Arranque (PC servidor)
```
cd scoreboard
node server.js
```
Imprime las direcciones, por ejemplo con IP `192.168.1.50`:

| Para | URL |
|---|---|
| Mesa / operador | `http://192.168.1.50:8080/control.html` |
| Pantalla (OBS) | `http://192.168.1.50:8080/display.html` |
| Rótulos (OBS) | `http://192.168.1.50:8080/popup.html` |

Si la otra PC no conecta: abre el puerto 8080 en el firewall de Windows y verifica que estén en la misma red. Si Resolume usa también el 8080, arranca el scoreboard con otro puerto: `PORT=9000 node server.js`.

## OBS → NDI → Resolume
1. En OBS usa **Fuente de navegador** (no captura de pantalla), 1920×1080, con la URL de `display.html`.
2. En el control pon **Centro de la pantalla = Transparente** para que Resolume ponga ahí anuncios y video.
3. DistroAV: activa **Main Output** y añade la fuente NDI en una capa superior de Resolume.
4. Si tu pared LED P3.91 no es 16:9, dime la resolución total en píxeles y adapto el diseño.

## Lo que hace el panel de control
- **Relojes:** juego y 24 s con atajos (`Espacio`, `1`=24, `2`=14, `S`=parar 24). El servidor lleva el tiempo, así control y pantalla siempre coinciden.
- **Contorno rojo:** al llegar a 0 el reloj del juego, los 24 s o un cronómetro, se enciende un contorno rojo alrededor de todo el diseño (como las luces del tablero en la NBA) durante 4 s. El botón *Probar contorno rojo* lo dispara a mano.
- **Posesión:** flechas junto al reloj (`P` alterna).
- **Tiempo fuera:** botón por equipo; descuenta el tiempo, para los relojes y muestra la cuenta regresiva de 60 s en el mismo reloj grande del juego (en amarillo, rojo en los últimos 10 s), con "TIEMPO FUERA" y el equipo en lugar del periodo y los 24 s; el centro de la pantalla no se toca. También descansos y medio tiempo. *Cancelar y devolver* restaura el tiempo fuera si se tocó por error.
- **Faltas y bonus** (reglas FIBA por defecto, configurables en Ajustes): con 5 faltas de equipo en el periodo el recuadro pasa a **BONUS** en rojo; el jugador se marca en amarillo con 4 faltas y en rojo con 5 (eliminado). Las faltas de equipo se reinician cada periodo y en el tiempo extra continúan las del 4to, como en FIBA. Para NBA pon 6 faltas para eliminar.
- **Marcador por periodo** (Q1, Q2, Q3, Q4, OT) bajo cada marcador.
- **Deshacer** (`Z`): revierte la última acción de marcador/estadísticas (no mueve los relojes).
- **Vistas del centro:** líderes del juego y comparativa de equipos.
- **FINAL:** marca el juego como terminado y lo guarda.

## Base de datos (SQLite)
`scoreboard.db` guarda automáticamente: el estado del juego (si se cierra el servidor, al abrir sigue donde iba), el historial de juegos, la jugada a jugada, y las **plantillas de equipos** (botones *Guardar actual / Cargar / Borrar*, o pega una lista `4, G. Torres, PG` por línea (número, nombre y posición opcional) con *Importar*). Para respaldar todo, copia `scoreboard.db`.

## Resumen del juego en PDF
Botón **Ver PDF del juego actual** en el control, o `http://IP:8080/report.pdf`. Incluye marcador, puntos por periodo, comparativa de equipos, líderes, estadísticas por jugador y jugada a jugada. Los juegos terminados quedan en el **Historial** con su PDF (`/report.pdf?game=1`).

## Rótulos de anotación (para Resolume)
`popup.html` es una página con fondo transparente que anima un rótulo (ej. "+3 G. TORRES") y lo oculta sola.

- **Cómo dispararlo:** botón *Lanzar rótulo* del control, automático al anotar (casilla en el control), o por HTTP: `/api/cmd?a=popup&l1=%2B3&l2=G.%20TORRES&l3=PONCE&team=home` (sirve para Stream Deck o Companion).
- **Cómo llevarlo a Resolume:** en OBS agrega `popup.html` como Fuente de navegador 1920×1080, ponle el filtro **Dedicated NDI Output** (DistroAV) y recíbelo en Resolume como otra fuente NDI en una capa encima del scoreboard.
- **Dónde diseñarlo:** el aspecto está en el bloque CSS marcado al inicio de `popup.html` (colores, tamaños, tipografía, animación). Para un diseño hecho en Illustrator, exporta tu arte a PNG con transparencia y úsalo como fondo del rótulo, dejando el texto dinámico encima. Prueba con `popup.html?test=1`.
- **Resolume directo (opcional):** Resolume 7.8 o más nuevo trae API REST/WebSocket (Preferencias → Webserver) para cambiar parámetros y disparar clips. Si quieres diseñar el rótulo dentro de Resolume (Text Block, Text Animator), este servidor puede enviarle el texto y disparar el clip; necesito la ruta del clip que muestra la API de tu Resolume.

## API HTTP (Stream Deck, Companion, botones físicos)
```
GET  /api/cmd?a=gameToggle              GET /api/cmd?a=shotReset&ms=24000
GET  /api/cmd?a=possessionToggle        GET /api/cmd?a=undo
GET  /api/cmd?a=timeoutStart&team=home  GET /api/cmd?a=periodNext
POST /api/cmd   {"a":"playerStat","team":"home","i":0,"stat":"pts","by":2}
GET  /api/state   /api/teams   /api/games   /report.pdf
```
