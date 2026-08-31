# Tests

Smoke test con Playwright, sin cámara real (no se puede simular un láser/cartucho
físico de forma automatizada). Verifica cosas que sí se pueden chequear sin
hardware: que la página carga sin errores, que ciertos elementos de UI están
o no están donde deben, y que funciones puntuales de JS hacen lo que dicen.

**Por qué existe esta carpeta**: hasta el build 2026-08-28.11 los tests vivían
sueltos en `/tmp` de la sesión de turno (por ejemplo `/tmp/tm_smoke*.js`), así
que cada vez que arrancaba una sesión nueva se perdían. Viven acá ahora para
que el próximo build pueda ampliarlos en vez de reescribirlos de cero.

## Cómo correrlo

```bash
# Desde la carpeta targetmind-web/
python3 -m http.server 8934 &
node tests/smoke.js
```

Necesita Playwright instalado (`npm install -g playwright` o como paquete
local) y Chromium descargado (`npx playwright install chromium`).

## Qué prueba `smoke.js` hoy

- La página carga sin errores de consola/JS (aparte de bloqueos de red del
  propio entorno de pruebas, si los hay — por ejemplo si Google Fonts está
  bloqueado en esa red, que no es un bug de la app).
- El número de build visible coincide con el esperado.
- Los paneles técnicos de debug (JSON del blanco, "Ver JSON") no están
  visibles en la página.
- `flashScreen()` (el flash verde/rojo de pantalla completa del drill de
  Fuego Seco) sube y baja la opacidad del overlay `#screenFlash` como se
  espera.
- `Target.zoneAt()` (blanco de puntería estilo IPSC, desde el build .14)
  clasifica bien un punto en cada zona conocida (cabeza/A, torso/D, afuera).
- Elegir la familia "Puntería (estilo IPSC)" en el generador cambia la UI
  correctamente (oculta lo que no aplica, muestra la nota aclaratoria) sin
  errores de consola, y el blanco generado dibuja algo real en el preview.

## Lo que NO prueba (y por qué)

Todo lo que depende de cámara real, láser/cartucho real, o munición real
—detección de anclajes contra video en vivo, detección del destello láser,
detección de impactos por diferencia de frames— no se puede simular en este
entorno sin hardware. Eso solo se puede verificar con el celular real, como
se viene haciendo hasta ahora (video grabado + reporte). El README es honesto
sobre esta distinción build por build: qué está "verificado con test/video
real" vs. "verificado solo por revisión de código".
