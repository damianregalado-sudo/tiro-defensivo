// Blancos de referencia (build .31) — catálogo de blancos de competencia/
// calificación reales (IDPA, IPSC, FBI Qual, BT-5S, Dot Torture, siluetas de
// cabeza y de rehén) con sus zonas de impacto ya digitalizadas.
//
// Qué es esto y qué NO es
// -----------------------
// Los blancos que GENERA la app (js/target.js, familias "reacción" y
// "puntería") se dibujan e imprimen desde cero acá adentro. Estos otros NO:
// son hojas que el tirador imprime aparte (img/blancos/*.jpg) y que la app
// solo tiene que saber PUNTUAR. Por eso este módulo no dibuja siluetas —
// dibuja el contorno de las zonas sobre el overlay de la cámara, y resuelve
// "este impacto en (gx,gy), ¿en qué zona cayó y cuánto vale?".
//
// Sistema de coordenadas
// ----------------------
// Todo acá está en la MISMA grilla normalizada 1000x1000 que usa el resto de
// la app después de la homografía (ver GRID en constants.js). Las zonas se
// midieron píxel a píxel sobre las imágenes de referencia originales
// (1179x1525) y se convirtieron a esta grilla, así que un impacto que llega
// como (gx,gy) desde vision.js/drill.js se puede probar directo contra
// estas formas sin ninguna conversión intermedia.
//
// Los cuatro modelos de puntaje
// -----------------------------
// Relevé cómo se puntúa cada uno de estos blancos en la realidad y NO hay un
// único sistema — son cuatro, y por eso `modelo` existe:
//
//   'anidado'   zonas concéntricas, vale la más interna que contenga al
//               impacto (IPSC, IDPA, BT-5S, silueta de cabeza).
//   'binario'   adentro/afuera, sin sub-zonas (FBI Qual: 2 puntos todo lo
//               que cae dentro de la botella, 0 afuera).
//   'puntos'    N figuras independientes, cada una impacto/no-impacto sin
//               sub-zonas (Dot Torture).
//   'discriminacion'  hay figuras que NO se deben disparar; pegarles resta
//               (blanco de rehén).
//
// `sentido` dice hacia dónde es "mejor":
//   'mayor'  más puntos es mejor (IPSC, FBI, BT-5S, Dot Torture, cabeza)
//   'menor'  menos es mejor — IDPA no suma puntos, DESCUENTA: cada "punto
//            abajo" es 1 segundo agregado al tiempo crudo. Por eso la zona
//            -0 vale 0 y errar vale 5.
//
// Fuentes de los valores (verificadas, no inventadas):
//   IPSC/USPSA  A=5; C=4 major / 3 minor; D=2 major / 1 minor; errar -10;
//               pegarle a un no-shoot -10. El puntaje real de una etapa es
//               el hit factor = puntos / tiempo.
//   IDPA        -0 = 0s, -1 = 1s, -3 = 3s, errar = 5s, no-threat = 5s.
//   FBI Qual    2 puntos por impacto dentro de la botella, 0 afuera;
//               50 tiros = 100 puntos; 80% aprueba (90% instructores).
//   Dot Torture 1 punto por impacto, 50 tiros, se aprueba solo con 50/50.
//   BT-5S y silueta de cabeza: NO tienen puntaje oficial publicado — el
//               BT-5S es un blanco de calificación policial con "zonas
//               sombreadas" y se puntúa adentro/afuera como el del FBI. La
//               escala 5/3/1 de esos dos es NUESTRA, propuesta, no oficial;
//               está marcada con `oficial: false` justamente para que la UI
//               pueda decirlo y nadie la confunda con una regla de verdad.
const Blancos = (() => {

  // rojo/ámbar/azul son los colores con los que se marcaron las zonas en las
  // imágenes de referencia. El "bucket" A/C/D es cómo se mapean a los
  // contadores que la pantalla de puntería ya tenía de antes (statPunteriaA/
  // C/D/Miss), así que un blanco de referencia reusa esa UI tal cual en vez
  // de necesitar una propia.
  const COLOR_BUCKET = { rojo: 'A', ambar: 'C', azul: 'D' };

  const CATALOGO = {
    idpa: {
      nombre: 'IDPA',
      imagen: 'img/blancos/idpa.jpg',
      modelo: 'anidado',
      sentido: 'menor',
      oficial: true,
      unidad: 'seg',
      regla: 'Cada punto abajo = 1 segundo sumado al tiempo. -0 es lo mejor, errar son 5.',
      zonas: [
        { id: '-0', color: 'rojo', valor: 0, formas: [
          { tipo: 'elipse', cx: 485.2, cy: 139.0, rx: 70.4, ry: 54.4 },
          { tipo: 'elipse', cx: 485.2, cy: 403.9, rx: 139.9, ry: 108.2 },
        ] },
        { id: '-1', color: 'ambar', valor: 1, formas: [
          { tipo: 'poly', puntos: [[373.2,209.8],[602.2,209.8],[698.0,301.6],[698.0,563.9],[684.5,590.2],[664.1,616.4],[643.8,642.6],[623.4,668.9],[603.1,695.1],[593.7,708.2],[381.7,708.2],[374.9,695.1],[351.1,668.9],[330.8,642.6],[309.6,616.4],[289.2,590.2],[277.4,563.9],[277.4,301.6]] },
        ] },
        { id: '-3', color: 'azul', valor: 3, formas: [
          { tipo: 'poly', puntos: [[380.8,41.3],[592.0,41.3],[592.0,205.9],[734.5,205.9],[805.8,294.4],[805.8,741.0],[770.1,793.4],[732.8,845.9],[709.9,878.7],[593.7,885.2],[381.7,885.2],[261.2,878.7],[238.3,845.9],[203.6,793.4],[168.8,741.0],[168.8,296.4],[239.2,205.9],[380.8,205.9]] },
        ] },
      ],
      fuera: { id: '-5', valor: 5 },
    },

    ipsc: {
      nombre: 'IPSC / USPSA',
      imagen: 'img/blancos/ipsc.jpg',
      modelo: 'anidado',
      sentido: 'mayor',
      oficial: true,
      unidad: 'pts',
      regla: 'A=5. C=4 (major) o 3 (minor). D=2 (major) o 1 (minor). Errar resta 10.',
      hitFactor: true,
      zonas: [
        { id: 'A', color: 'rojo', valorMajor: 5, valorMinor: 5, formas: [
          { tipo: 'rect', x0: 428.3, y0: 75.4, x1: 572.5, y1: 127.9 },
          { tipo: 'rect', x0: 398.6, y0: 262.3, x1: 606.4, y1: 563.9 },
        ] },
        { id: 'C', color: 'ambar', valorMajor: 4, valorMinor: 3, formas: [
          { tipo: 'poly', puntos: [[387.6,196.7],[371.5,223.0],[343.5,236.1],[296.0,262.3],[296.0,524.6],[310.4,590.2],[347.8,655.7],[363.0,688.5],[415.6,701.6],[500.4,704.9],[585.2,701.6],[642.9,688.5],[660.7,655.7],[695.5,590.2],[709.1,524.6],[709.1,262.3],[659.9,236.1],[631.9,223.0],[614.1,196.7]] },
        ] },
        { id: 'D', color: 'azul', valorMajor: 2, valorMinor: 1, formas: [
          { tipo: 'poly', puntos: [[387.6,41.3],[614.1,41.3],[614.1,196.7],[824.4,262.3],[824.4,688.5],[716.7,859.0],[284.1,859.0],[179.0,688.5],[179.0,262.3],[387.6,196.7]] },
        ] },
      ],
      fuera: { id: 'miss', valor: -10 },
      penalNoShoot: -10,
    },

    fbiqual: {
      nombre: 'FBI Qual',
      imagen: 'img/blancos/fbiqual.jpg',
      modelo: 'binario',
      sentido: 'mayor',
      oficial: true,
      unidad: 'pts',
      regla: '2 puntos todo lo que cae adentro, 0 afuera. 50 tiros = 100 puntos; 80% aprueba.',
      objetivo: { tiros: 50, maximo: 100, aprueba: 0.8 },
      zonas: [
        { id: 'adentro', color: 'rojo', valor: 2, formas: [
          { tipo: 'rect', x0: 422.4, y0: 108.2, x1: 576.8, y1: 226.2 },
          { tipo: 'rect', x0: 405.4, y0: 508.2, x1: 606.4, y1: 747.5 },
        ] },
      ],
      fuera: { id: 'miss', valor: 0 },
    },

    bt5s: {
      nombre: 'BT-5S (calificación policial)',
      imagen: 'img/blancos/bt5s.jpg',
      modelo: 'anidado',
      sentido: 'mayor',
      oficial: false,
      unidad: 'pts',
      regla: 'Propuesto por nosotros (este blanco no tiene tabla oficial): centro 5, media 3, zona válida no vital 1.',
      zonas: [
        { id: 'A', color: 'rojo', valor: 5, formas: [
          { tipo: 'rect', x0: 411.4, y0: 485.2, x1: 589.5, y1: 685.2 },
        ] },
        { id: 'C', color: 'ambar', valor: 3, formas: [
          { tipo: 'rect', x0: 309.6, y0: 403.3, x1: 691.3, y1: 754.1 },
        ] },
        { id: 'D', color: 'azul', valor: 1, formas: [
          { tipo: 'poly', puntos: [[453.8,334.4],[384.2,350.8],[349.4,367.2],[307.0,383.6],[263.8,400.0],[230.7,416.4],[204.4,432.8],[191.7,449.2],[181.5,465.6],[176.4,482.0],[173.9,498.4],[174.7,531.1],[174.7,563.9],[175.6,596.7],[183.2,629.5],[205.3,662.3],[227.3,695.1],[244.3,727.9],[260.4,760.7],[280.7,793.4],[351.1,826.2],[642.9,826.2],[710.8,793.4],[725.2,760.7],[738.8,727.9],[759.1,695.1],[783.7,662.3],[818.5,629.5],[829.5,596.7],[828.7,563.9],[827.0,531.1],[827.0,498.4],[824.4,482.0],[815.9,465.6],[803.2,449.2],[782.9,432.8],[750.6,416.4],[709.9,400.0],[676.8,383.6],[637.8,367.2],[602.2,350.8],[524.2,334.4]] },
        ] },
      ],
      fuera: { id: 'miss', valor: 0 },
    },

    dottorture: {
      nombre: 'Dot Torture',
      imagen: 'img/blancos/dottorture.jpg',
      modelo: 'puntos',
      sentido: 'mayor',
      oficial: true,
      unidad: 'pts',
      regla: '1 punto por impacto. 50 tiros, y solo se aprueba con 50/50 — recién ahí se aumenta la distancia.',
      objetivo: { tiros: 50, maximo: 50, aprueba: 1 },
      zonas: [
        { id: 'dot1', color: 'rojo', valor: 1, formas: [{ tipo: 'elipse', cx: 509.8, cy: 134.4, rx: 105.2, ry: 81.3 }] },
        { id: 'dot2', color: 'rojo', valor: 1, formas: [{ tipo: 'elipse', cx: 203.6, cy: 334.4, rx: 107.7, ry: 83.3 }] },
        { id: 'dot3', color: 'rojo', valor: 1, formas: [{ tipo: 'elipse', cx: 508.9, cy: 334.4, rx: 107.7, ry: 83.3 }] },
        { id: 'dot4', color: 'rojo', valor: 1, formas: [{ tipo: 'elipse', cx: 811.7, cy: 334.4, rx: 107.7, ry: 83.3 }] },
        { id: 'dot5', color: 'rojo', valor: 1, formas: [{ tipo: 'elipse', cx: 203.6, cy: 535.7, rx: 107.7, ry: 83.3 }] },
        { id: 'dot6', color: 'rojo', valor: 1, formas: [{ tipo: 'elipse', cx: 508.9, cy: 535.7, rx: 107.7, ry: 83.3 }] },
        { id: 'dot7', color: 'rojo', valor: 1, formas: [{ tipo: 'elipse', cx: 811.7, cy: 535.7, rx: 107.7, ry: 83.3 }] },
        { id: 'dot8', color: 'rojo', valor: 1, formas: [{ tipo: 'elipse', cx: 203.6, cy: 734.4, rx: 107.7, ry: 83.3 }] },
        { id: 'dot9', color: 'rojo', valor: 1, formas: [{ tipo: 'elipse', cx: 508.9, cy: 734.4, rx: 107.7, ry: 83.3 }] },
        { id: 'dot10', color: 'rojo', valor: 1, formas: [{ tipo: 'elipse', cx: 811.7, cy: 734.4, rx: 107.7, ry: 83.3 }] },
      ],
      fuera: { id: 'miss', valor: 0 },
    },

    headshot: {
      nombre: 'Silueta de cabeza',
      imagen: 'img/blancos/headshot.jpg',
      modelo: 'anidado',
      sentido: 'mayor',
      oficial: false,
      unidad: 'pts',
      regla: 'Propuesto por nosotros (no hay estándar oficial): entre los ojos 5, triángulo ojos/nariz 3, resto de la cabeza 1.',
      zonas: [
        { id: 'A', color: 'rojo', valor: 5, formas: [
          { tipo: 'elipse', cx: 511.5, cy: 419.7, rx: 47.5, ry: 36.7 },
        ] },
        { id: 'C', color: 'ambar', valor: 3, formas: [
          { tipo: 'poly', puntos: [[337.6,380.3],[681.9,380.3],[517.4,527.9]] },
        ] },
        { id: 'D', color: 'azul', valor: 1, formas: [
          { tipo: 'elipse', cx: 515.7, cy: 417.7, rx: 220.5, ry: 170.5 },
        ] },
      ],
      fuera: { id: 'miss', valor: 0 },
    },

    hostage: {
      nombre: 'Rehén (discriminación)',
      imagen: 'img/blancos/hostage.jpg',
      modelo: 'discriminacion',
      sentido: 'mayor',
      oficial: false,
      unidad: 'pts',
      regla: 'Cabeza de la amenaza +5. Pegarle al rehén -10. Es el blanco donde el error importa más que el acierto.',
      zonas: [
        { id: 'amenaza', color: 'rojo', valor: 5, formas: [
          { tipo: 'elipse', cx: 496.2, cy: 230.8, rx: 61.1, ry: 47.2 },
        ] },
        { id: 'rehen', color: 'negro', valor: -10, penalizacion: true, formas: [
          { tipo: 'elipse', cx: 678.5, cy: 249.2, rx: 80.6, ry: 62.3 },
          { tipo: 'elipse', cx: 678.5, cy: 547.5, rx: 84.8, ry: 65.6 },
        ] },
      ],
      fuera: { id: 'miss', valor: 0 },
    },
  };

  // ---- hit-test ----------------------------------------------------------
  // Misma convención (y prácticamente el mismo código) que pointInRect/
  // pointInCircle/pointInPolygon de target.js — se repiten acá a propósito
  // en vez de exportarlas desde allá: target.js las tiene escritas contra su
  // propio formato de zona ({cx,cy,w,h} centrado), y estas trabajan sobre el
  // formato {x0,y0,x1,y1} que sale de medir sobre una imagen. Unificarlas
  // obligaría a convertir de un lado o del otro en cada disparo.
  // Los círculos de las imágenes de referencia se guardan como ELIPSE, no
  // como círculo con un radio solo. No es un capricho: la grilla 1000x1000
  // es anisotrópica respecto de la hoja (las imágenes miden 1179x1525), así
  // que un círculo perfecto impreso NO es un círculo en coordenadas de
  // grilla — es una elipse con rx/ry distintos en casi un 30%. Guardar un
  // radio promedio (el primer intento) hacía que el hit-test de, por
  // ejemplo, la cabeza del headshot se pasara ~13% en horizontal y se
  // quedara ~13% corto en vertical: tiros buenos contados como fuera y al
  // revés. Con rx/ry separados el test es exacto.
  function enElipse(x, y, f) {
    const dx = (x - f.cx) / f.rx, dy = (y - f.cy) / f.ry;
    return dx * dx + dy * dy <= 1;
  }
  function enRect(x, y, f) {
    return x >= f.x0 && x <= f.x1 && y >= f.y0 && y <= f.y1;
  }
  function enPoly(x, y, f) {
    const p = f.puntos;
    let dentro = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const xi = p[i][0], yi = p[i][1], xj = p[j][0], yj = p[j][1];
      const cruza = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (cruza) dentro = !dentro;
    }
    return dentro;
  }
  function enForma(x, y, f) {
    if (f.tipo === 'elipse') return enElipse(x, y, f);
    if (f.tipo === 'rect') return enRect(x, y, f);
    if (f.tipo === 'poly') return enPoly(x, y, f);
    return false;
  }

  function get(blancoId) { return CATALOGO[blancoId] || null; }
  function listar() {
    return Object.keys(CATALOGO).map(id => ({ id, ...CATALOGO[id] }));
  }
  function existe(blancoId) { return !!CATALOGO[blancoId]; }

  // Devuelve la zona en la que cayó el impacto, o null si quedó fuera de
  // todas. Las zonas de cada blanco están declaradas de la MÁS INTERNA a la
  // más externa, así que el primer match ganando es exactamente el
  // comportamiento anidado que se quiere (un tiro en el centro está también
  // dentro de C y de D, y tiene que contar como A).
  function zonaEn(blancoId, gx, gy) {
    const b = CATALOGO[blancoId];
    if (!b) return null;
    for (const z of b.zonas) {
      for (const f of z.formas) {
        if (enForma(gx, gy, f)) return z;
      }
    }
    return null;
  }

  // Resuelve un impacto completo: en qué zona cayó, cuánto vale y en qué
  // contador de la UI de puntería suma. `opts.powerFactor` ('major'|'minor')
  // solo lo mira IPSC; el resto de los blancos lo ignora.
  function evaluar(blancoId, gx, gy, opts) {
    const b = CATALOGO[blancoId];
    if (!b) return null;
    const pf = (opts && opts.powerFactor) === 'minor' ? 'minor' : 'major';
    const z = zonaEn(blancoId, gx, gy);
    if (!z) {
      return {
        zonaId: b.fuera.id,
        bucket: 'miss',
        valor: b.fuera.valor,
        penalizacion: false,
        sentido: b.sentido,
        unidad: b.unidad,
      };
    }
    let valor = z.valor;
    if (valor === undefined) valor = pf === 'minor' ? z.valorMinor : z.valorMajor;
    return {
      zonaId: z.id,
      bucket: z.penalizacion ? 'penal' : (COLOR_BUCKET[z.color] || 'A'),
      valor,
      penalizacion: !!z.penalizacion,
      sentido: b.sentido,
      unidad: b.unidad,
    };
  }

  // Total de una serie. Se separa de evaluar() porque IDPA no se suma igual
  // que los demás: ahí el "puntaje" son segundos de castigo, así que el
  // total sigue siendo una suma pero se lee al revés (menos es mejor) — por
  // eso se devuelve `sentido` junto con el número, en vez de que cada
  // pantalla tenga que acordarse de cuál blanco era.
  function totalDe(blancoId, impactos) {
    const b = CATALOGO[blancoId];
    if (!b) return null;
    let total = 0;
    (impactos || []).forEach(i => { total += (i && typeof i.valor === 'number') ? i.valor : 0; });
    return { total, sentido: b.sentido, unidad: b.unidad, oficial: b.oficial };
  }

  // Dibuja el contorno punteado de las zonas sobre el overlay de la cámara,
  // mismo criterio de color que ya usa drill.js para los impactos (verde=A,
  // amarillo=C, naranja=D) para que el tirador vea contra qué se lo está
  // evaluando. sx/sy/originX/originY: misma convención que
  // Target.drawIpscSilhouette().
  function dibujar(ctx, blancoId, sx, sy, originX, originY) {
    const b = CATALOGO[blancoId];
    if (!b || !ctx) return;
    const toPx = (gx, gy) => [originX + gx * sx, originY + gy * sy];
    const colorDe = (z) => z.penalizacion ? '#e5484d'
      : z.color === 'rojo' ? '#45b26b'
      : z.color === 'ambar' ? '#f4c430' : '#ff7a1a';
    ctx.save();
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    // De atrás para adelante (la zona más externa primero) para que las
    // líneas de las zonas chicas queden arriba y no se coman entre sí.
    for (let i = b.zonas.length - 1; i >= 0; i--) {
      const z = b.zonas[i];
      ctx.strokeStyle = colorDe(z);
      for (const f of z.formas) {
        ctx.beginPath();
        if (f.tipo === 'elipse') {
          const [px, py] = toPx(f.cx, f.cy);
          ctx.ellipse(px, py, f.rx * sx, f.ry * sy, 0, 0, Math.PI * 2);
        } else if (f.tipo === 'rect') {
          const [x0, y0] = toPx(f.x0, f.y0);
          const [x1, y1] = toPx(f.x1, f.y1);
          ctx.rect(x0, y0, x1 - x0, y1 - y0);
        } else if (f.tipo === 'poly') {
          f.puntos.forEach((p, idx) => {
            const [px, py] = toPx(p[0], p[1]);
            if (idx === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          });
          ctx.closePath();
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  return { get, listar, existe, zonaEn, evaluar, totalDe, dibujar, CATALOGO };
})();

// Los tests corren este archivo en node (sin DOM), así que se exporta
// también como módulo CommonJS cuando existe `module` — en el navegador esa
// rama sencillamente no se toma y `Blancos` queda como global, igual que el
// resto de los archivos de js/ (scripts clásicos con defer, no ES modules).
if (typeof module !== 'undefined' && module.exports) module.exports = { Blancos };
