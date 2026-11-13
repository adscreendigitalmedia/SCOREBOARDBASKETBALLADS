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
- **Vistas del centro:** líderes del juego y comparativa de equipos. Sus colores se cambian en *Colores de Líderes / Comparativa*; con **Mismo color del fondo (automático)** el fondo y las franjas toman el color de tu imagen de fondo detrás del centro (colores planos, sin degradado) y se actualizan solos si cambias la imagen.
- **FINAL:** marca el juego como terminado y lo guarda.

## Usuarios y roles
El panel pide **usuario y contraseña**. La primera vez entra con `admin` / `admin`; se te pide cambiarla de inmediato.
En el **Dashboard** (`/admin.html`, enlace *Dashboard* en el panel) creas una cuenta para cada persona y marcas sus roles y permisos. Una cuenta nueva **empieza sin roles ni permisos**: solo puede mirar hasta que le des algo. Un usuario puede tener varios roles; cada quien ve solo sus secciones y el **servidor rechaza** cualquier acción fuera de sus roles.

| Rol | Qué maneja |
|---|---|
| Relojes | reloj de juego, 24 s, 14 s, periodos (`Espacio`, `1`, `2`, `S`) |
| Anotación | marcador, faltas, estadísticas, jugadores en cancha, logos y nombres, plantillas, deshacer (`Z`) |
| Jugada | posesión (`P`), tiempos fuera y su duración, descansos, FINAL, vista del centro |
| Pantallas | título, centro de la pantalla, fondo / plantilla, colores de Líderes y Comparativa |
| *Permiso* Crear juego nuevo | botón **Nuevo juego** (guarda el actual en el historial y empieza otro) |
| *Permiso* Editar juegos del historial | corregir nombres y marcador final de juegos terminados, o borrarlos (Dashboard → Juegos) |
| Admin | todo, más usuarios, reglas de la liga, plantillas de equipos, dashboard y registro de actividad |

- Las cuentas nuevas reciben una **contraseña temporal** y deben cambiarla al entrar. Siempre queda al menos un administrador activo.
- Al **desactivar** un usuario, su sesión abierta deja de funcionar al instante.
- **Dashboard** con menú: *Resumen* (cuántos juegos hay en curso ahora, el de baloncesto y el de béisbol con su marcador y estado, quién está conectado y cuántas pantallas), *Usuarios y permisos*, *Juegos* (historial), *Actividad*, *Stream Deck* y *Respaldos*. El béisbol se lee de `ws://127.0.0.1:3001/ws`; si corre en otro puerto, arranca el servidor con `BASEBALL_WS=ws://127.0.0.1:PUERTO/ws`.
- **Programar juegos** (Dashboard → Programar juegos, Admin): fecha y hora, equipos (de las plantillas guardadas, así se cargan jugadores y logos, o un nombre escrito), notas y **usuarios de la mesa**. Cada usuario asignado ve el juego en su panel al entrar; quien tenga *Crear juego nuevo* pulsa **Empezar este juego** (guarda el actual en el historial y carga los equipos). Mientras ese juego está en curso, **solo los asignados y Admin** pueden operar; los demás solo miran (la clave del Stream Deck sigue funcionando). Al pulsar *Nuevo juego* el programado queda *Terminado*. No arranca solo a la hora, para no reiniciar un juego por error.
- El **registro de actividad** (Dashboard → Actividad) guarda quién hizo cada acción y a qué hora.
- Con varios roles, `?rol=relojes` (etc.) filtra la vista a uno solo.
- `display.html` y `popup.html` **no** piden contraseña: son solo de lectura, para OBS.
- Contraseña de admin olvidada: con el servidor apagado, en la carpeta `scoreboard` corre
  `node -e "const s=require('./db').open(),a=require('./auth');const u=s.getUserByName('admin');s.setPassword(u.id,a.hashPassword('admin'),true)"`
  y vuelve a entrar con `admin` / `admin`.

Recomendación: en juegos grandes, 3 personas (relojes, anotación, jugada); si solo hay 2, junta *Jugada* con *Relojes*; con 1 persona, un usuario con todos los roles. Los paneles se pueden abrir en tablets distintas sin instalar nada.

## Logos y fondo (sin tocar archivos)
En el panel (rol *Anotación* o *Ajustes*): **Logo del equipo → Elegir archivo** (PNG con fondo transparente, cuadrado o apaisado; se ajusta solo). **Fondo / diseño de la pantalla → Elegir archivo** (PNG 1920×1080). Con *Usar solo mi imagen* se quitan los colores de las cajas y se ve tu diseño con los textos encima. Los archivos se guardan en `public/logos/` y `public/bg/`. La guía `guia-medidas.png` marca dónde cae cada zona para que tu PNG coincida.

## Estadísticas del centro por encima de los anuncios (capas en Resolume)
Si los anuncios están en una capa por encima del scoreboard, las estadísticas del centro quedan tapadas. Solución: dos fuentes de OBS, cada una con su salida NDI:
- `display.html?layer=base` → todo el scoreboard menos las estadísticas del centro (el centro queda transparente).
- `display.html?layer=stats` → solo las estadísticas del centro (todo lo demás transparente).

Orden en Resolume, de abajo hacia arriba: `base` → anuncios → `stats` → `popup`. Las estadísticas (líderes/comparativa) salen siempre sobre los anuncios, y cuando el centro está en *Ninguna* la capa `stats` es invisible y se ven los anuncios. En OBS, a cada fuente de navegador ponle el filtro **Dedicated NDI Output**.

## Vista previa en el panel
Arriba del panel, **todos los usuarios** (sin importar el rol) ven la pantalla **en vivo**, igual que en OBS. Puedes elegir qué pantalla ver, el tamaño (chica, mediana o grande), **📌 Fijar arriba** para que no se pierda al bajar, u ocultarla. Cada navegador recuerda su elección.

## Varias pantallas y tamaños
Estos ajustes están **ocultos** en el panel; para verlos marca *Mostrar ajustes de pantallas* en la sección *Pantallas: diseño*. Las pantallas que ya existen siguen funcionando igual aunque estén ocultos.

En el panel, sección **Pantallas: diseño → Pantallas y tamaños** (rol *Pantallas* o *Admin*):
- **Agregar pantalla:** nombre y tamaño (Full HD, HD, 4K, atajos P3.91 por gabinetes o *Personalizado*). Las proporciones se calculan solas para ese tamaño.
- Todas muestran **el mismo scoreboard**; cada una tiene su enlace para OBS: la Principal es `display.html`, las demás `display.html?p=<id>` (botón *Copiar*). En OBS pon la Fuente de navegador con el mismo ancho y alto de la pantalla.
- **Proporciones:** escala de letra, alto del título y del marcador, ancho de marcadores, reloj y laterales, alto de las estadísticas y de la franja, separaciones y márgenes (en px del lienzo). Si algo no cabe, aparece un aviso.
- **Ajustar proporciones al tamaño:** recalcula todo después de cambiar ancho y alto.
- **Fondo propio:** cada pantalla puede tener su PNG (del mismo tamaño que la pantalla); si no, usa el fondo general.
- La **Principal** no se puede borrar y conserva las medidas de la plantilla de abajo.
- **Diseño de cada pantalla:** *Tablero completo*, *Marcador tipo TV* o *Automático* (marcador tipo TV cuando el tablero completo no cabe, por ejemplo en un póster LED de 256×768).
- **Marcador tipo TV**, dos estilos: **Fila de arriba del tablero** (las mismas piezas de la fila superior del tablero: logos, puntos con Q1/Q2, reloj con posesión, periodo y 24). Se acomoda a la forma del área: *franja* (la fila tal cual, con el pedazo de tu plantilla), *caja* (equipos arriba, reloj abajo) o *póster* (todo apilado, ideal para 256×768) o **Banner TV compacto** (logos, siglas, puntos, periodo, reloj, 24 s, faltas/BONUS, tiempos fuera y posesión). Ocupa **solo una parte** de la pantalla (*Posición*: arriba, abajo, lados, esquinas o centro; *Ancho %* y *Alto %*) y **el resto queda transparente** para poner anuncios en Resolume en una capa de abajo. Por defecto es un **banner delgado abajo, estilo NBA** (50% de ancho, 8% de alto: 960×86 px en 1920×1080); el *Atajo* trae banner arriba, esquinas y franjas. Se acomoda a la forma del área: banner, barra, caja o vertical. Para ponerlo **en cualquier lugar** (no pegado a los bordes), arrastra el rectángulo azul en la miniatura de la pantalla o elige *Posición: Libre* y escribe *X %* / *Y %*. El contorno rojo de la bocina sale solo alrededor del marcador.
- **Diseño TV propio (tu imagen):** en *Pantallas → Diseños TV propios* sube tu banner hecho en Photoshop o Canva (PNG con transparencia, WebP, JPG o SVG). Encima aparecen cajas para cada dato: logos, nombres, puntos, faltas, tiempos fuera, BONUS, posesión, periodo, reloj y 24. **Arrastra** cada caja a su lugar; la esquina amarilla cambia el tamaño. En la tabla *Datos* eliges si se ve, el texto ("F ", "TF ", "BONUS", el símbolo de posesión), el tamaño de letra (% del alto de la caja), el color, la alineación, las siglas en lugar del nombre y la posición exacta. *Letra* acepta una fuente instalada en la PC (ej. *Oswald*). Después, en cada pantalla elige **Estilo: Diseño propio** y el diseño; **Alto según la imagen** deja el área con la misma forma que tu imagen (la imagen nunca se deforma). *Cambiar imagen* reemplaza el arte y conserva las posiciones. **Exportar** baja un archivo .json con la imagen incluida; con **Importar** lo subes en otro servidor (por ejemplo, del Mac al servidor de la cancha). Rol: Pantallas.

## Medidas de la pantalla Principal (lienzo 1920×1080 px)
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

## Respaldos
`scoreboard/respaldo.sh` está instalado en el servidor en `~/respaldos-scoreboard/` y corre con cron todos los días a las 4:15 a. m. (hora de PR). Copia la base de datos sin detener el servicio, junto con los logos y fondos subidos. También respalda el scoreboard de béisbol. Guarda 30 días.
- Correrlo a mano: `ssh scoreboard '~/respaldos-scoreboard/respaldo.sh'`
- Ver el registro: `ssh scoreboard 'tail ~/respaldos-scoreboard/respaldo.log'`
- Bajar una copia a la Mac (por si falla el disco del servidor): `rsync -a scoreboard:respaldos-scoreboard/ ~/Documents/respaldos-scoreboard/`
- Restaurar: detener el servicio, descomprimir el `.tar.gz` y poner `scoreboard.db` (y `public/logos`, `public/bg`) en la carpeta del proyecto; luego arrancar el servicio.

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
Los comandos necesitan la **clave** que aparece en *Usuarios → Clave para Stream Deck* (`key=`). Si generas una clave nueva, actualiza los botones.
```
GET  /api/cmd?key=CLAVE&a=gameToggle              GET /api/cmd?key=CLAVE&a=shotReset&ms=24000
GET  /api/cmd?key=CLAVE&a=possessionToggle        GET /api/cmd?key=CLAVE&a=undo
GET  /api/cmd?key=CLAVE&a=timeoutStart&team=home  GET /api/cmd?key=CLAVE&a=periodNext
POST /api/cmd?key=CLAVE   {"a":"playerStat","team":"home","i":0,"stat":"pts","by":2}
GET  /api/state   (abierta, solo lectura)
```
