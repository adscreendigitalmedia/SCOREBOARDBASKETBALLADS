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
    logos/         logos subidos desde el panel (o ponlos a mano)
    bg/            fondo subido desde el panel
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
- **Relojes:** juego y 24 s con atajos (`Espacio`, `1`=24, `2`=14, `S`=parar 24). El servidor lleva el tiempo, así control y pantalla siempre coinciden. **El reloj de 24 se apaga solo** cuando al juego le quedan menos de 24 s (se oculta en pantalla, deja de contar y no suena la violación); se cambia en Ajustes (*Apagar 24 con menos de … s*, 0 = nunca).
- **Contorno rojo:** al llegar a 0 el reloj del juego, los 24 s o un cronómetro, se enciende un contorno rojo alrededor de todo el diseño (como las luces del tablero en la NBA) durante 4 s. El botón *Probar contorno rojo* lo dispara a mano.
- **Posesión:** flechas junto al reloj (`P` alterna).
- **Tiempos fuera disponibles:** junto a cada botón hay **−/+** para corregir. Se recargan solos según la liga (Ajustes): al empezar el juego, al empezar el 3er periodo y en cada tiempo extra (FIBA 2/3/1, NBA 7/0/2; 0 = siguen los que queden).
- **Tiempo fuera:** botón por equipo; descuenta el tiempo, para los relojes y muestra la cuenta regresiva de 60 s en el mismo reloj grande del juego (en amarillo, rojo en los últimos 10 s), con "TIEMPO FUERA" y el equipo en lugar del periodo y los 24 s; el centro de la pantalla no se toca. La **duración** se elige junto a los botones (15, 30, 60, 75 o 90 s) o se escribe otra en Ajustes; por API: `/api/cmd?a=timeoutStart&team=home&ms=30000`. También descansos y medio tiempo. *Cancelar y devolver* restaura el tiempo fuera si se tocó por error.
- **Faltas y bonus:** en Ajustes pones con cuántas faltas de equipo en el periodo se enciende **BONUS** en rojo (FIBA 4, NBA 5). Al pasar al siguiente periodo las faltas de equipo vuelven a 0 y el BONUS se apaga, también en tiempo extra (si prefieres la regla FIBA de seguir con las faltas del 4to en el OT, marca *En tiempo extra seguir las faltas del 4to*). El jugador se marca en amarillo a una falta de eliminarse y en rojo al eliminarse (FIBA 5, NBA 6, se cambia en Ajustes).
- **Orden de jugadores:** en la pantalla los 5 en cancha se ordenan de mayor a menor puntos (con igual puntaje, el orden de la plantilla). Un jugador que entra por sustitución queda según sus puntos, no abajo. Se apaga en Ajustes.
- **Marcador por periodo** (Q1, Q2, Q3, Q4, OT) bajo cada marcador.
- **Deshacer** (`Z`): revierte la última acción de marcador, faltas o estadísticas. No toca relojes, posesión, periodo ni tiempos fuera, para que varios operadores no se pisen.
- **Vistas del centro:** líderes del juego y comparativa de equipos.
- **FINAL:** marca el juego como terminado y lo guarda.

## Roles: varias personas en la mesa
Cada operador abre el mismo panel con su rol (cada rol solo muestra lo suyo y sus atajos). Sin `?rol=` se ve todo.

| Rol | URL | Qué maneja |
|---|---|---|
| Relojes | `/control.html?rol=relojes` | reloj de juego, 24 s, 14 s, periodos (`Espacio`, `1`, `2`, `S`) |
| Anotación | `/control.html?rol=anotacion` | marcador, faltas, estadísticas, plantillas en cancha, deshacer (`Z`) |
| Jugada y pantalla | `/control.html?rol=jugada` | posesión (`P`), tiempos fuera, descansos, FINAL, vista del centro, rótulos |
| Ajustes | `/control.html?rol=admin` | logos, fondo, plantillas, PDF, reglas (se usa antes del juego) |

Recomendación: en juegos grandes, 3 personas (relojes, anotación, jugada); si solo hay 2, junta *Jugada* con *Relojes*; con 1 persona usa la vista completa. Los tres paneles se pueden abrir en tablets distintas sin instalar nada.

## Logos y fondo (sin tocar archivos)
En el panel (rol *Anotación* o *Ajustes*): **Logo del equipo → Elegir archivo** (PNG con fondo transparente, cuadrado o apaisado; se ajusta solo). **Fondo / diseño de la pantalla → Elegir archivo** (PNG 1920×1080). Con *Usar solo mi imagen* se quitan los colores de las cajas y se ve tu diseño con los textos encima. Los archivos se guardan en `public/logos/` y `public/bg/`. La guía `guia-medidas.png` marca dónde cae cada zona para que tu PNG coincida.

## Estadísticas del centro por encima de los anuncios (capas en Resolume)
Si los anuncios están en una capa por encima del scoreboard, las estadísticas del centro quedan tapadas. Solución: dos fuentes de OBS, cada una con su salida NDI:
- `display.html?layer=base` → todo el scoreboard menos las estadísticas del centro (el centro queda transparente).
- `display.html?layer=stats` → solo las estadísticas del centro (todo lo demás transparente).

Orden en Resolume, de abajo hacia arriba: `base` → anuncios → `stats` → `popup`. Las estadísticas (líderes/comparativa) salen siempre sobre los anuncios, y cuando el centro está en *Ninguna* la capa `stats` es invisible y se ven los anuncios. En OBS, a cada fuente de navegador ponle el filtro **Dedicated NDI Output**.

## Medidas de la pantalla (lienzo 1920×1080 px)
| Zona | x | y | ancho | alto |
|---|---|---|---|---|
| Centro (estadísticas / anuncios) | 525 | 347 | 870 | 560 |
| Franja inferior de anuncios | 525 | 923 | 870 | 137 |
| Equipo local (tabla) | 25 | 347 | 482 | 503 |
| Equipo local (estadísticas) | 25 | 867 | 482 | 193 |
| Equipo visitante | 1413 | 347 | 482 | 713 |
| Marcador superior | 25 | 87 | 1870 | 243 |
| Título | 25 | 18 | 1870 | 52 |

Las medidas coinciden con la plantilla `led_scoreboard_layout_vacio.png`: súbela como fondo en el panel y marca *Usar solo mi imagen*.

El borde blanco de 3 px de cada caja está dentro de esas medidas.

## Base de datos (SQLite)
`scoreboard.db` guarda automáticamente: el estado del juego (si se cierra el servidor, al abrir sigue donde iba), el historial de juegos, la jugada a jugada, y las **plantillas de equipos** (botones *Guardar actual / Cargar / Borrar*, o pega una lista `4, G. Torres, PG` por línea (número, nombre y posición opcional) con *Importar*). Para respaldar todo, copia `scoreboard.db`.

## Resumen del juego en PDF
Botón **Ver PDF del juego actual** en el control, o `http://IP:8080/report.pdf`. Incluye marcador, puntos por periodo, comparativa de equipos, líderes, estadísticas por jugador y jugada a jugada. Los juegos terminados quedan en el **Historial** con su PDF (`/report.pdf?game=1`).

## Rótulos de anotación (para Resolume) — oculto en el panel
La sección está oculta en el panel porque no se usa; `popup.html` y la API siguen funcionando. Para mostrarla, en `control.html` quita `hidden` de la sección *Rótulo de anotación*.
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
