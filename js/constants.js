// Shared constants used across target generation, vision and drill logic.
// Everything downstream of homography works in this normalized 1000x1000 grid,
// regardless of the physical paper size — that's the whole point of warping.
const GRID = 1000;

const SHAPE_COLORS = [
  { id: 'red',    name: 'Rojo',      css: '#e5484d' },
  { id: 'blue',   name: 'Azul',      css: '#4a9fe0' },
  { id: 'yellow', name: 'Amarillo',  css: '#f4c430' },
  { id: 'green',  name: 'Verde',     css: '#45b26b' },
];
const SHAPE_TYPES = [
  { id: 'circle',   name: 'Círculo' },
  { id: 'square',   name: 'Cuadrado' },
  { id: 'triangle', name: 'Triángulo' },
];
const COLOR_MAP = Object.fromEntries(SHAPE_COLORS.map(c => [c.id, c]));
const TYPE_MAP = Object.fromEntries(SHAPE_TYPES.map(t => [t.id, t]));

// mm dimensions. pageW/H = physical paper. safeW/H = printable area after the
// mandatory 10mm non-printable margin on every side.
const PAGE_SPECS = {
  A4:     { pageW: 210,   pageH: 297,   safeW: 190,   safeH: 277,   label: 'A4' },
  A3:     { pageW: 297,   pageH: 420,   safeW: 277,   safeH: 400,   label: 'A3' },
  OFICIO: { pageW: 215.9, pageH: 355.6, safeW: 195.9, safeH: 335.6, label: 'Oficio/Legal' },
};

// Fiducial corner markers, in grid units, measured from the safe-canvas edge.
const FIDUCIAL_MARGIN = 40;
const FIDUCIAL_SIZE = 46;
// Centered on the bottom edge, well clear of all 4 corner fiducials (each
// corner fiducial occupies roughly [17,63] to [937,983] in grid units).
// This used to sit in the bottom-right corner and directly overlapped that
// fiducial (see printed samples showing the metatag painted over the
// corner marker) — that overlap was corrupting the corner the auto-lock
// homography depends on, which is why calibration was failing. Moving it
// to the bottom-center strip keeps it fully separate from every fiducial.
const METATAG_ZONE = { x0: 410, y0: 735, x1: 585, y1: 910 };

// Reserved zone for the optional "compartir blanco" QR code (build .18) —
// same y-band as METATAG_ZONE, mirrored to its right, so both live in the
// existing bottom margin strip without touching any corner fiducial or each
// other. This is only an EXCLUSION box for keeping random shapes clear of
// it (used by generateShapes, same pattern as METATAG_ZONE) — the QR
// itself must be physically SQUARE, and this box's grid-unit width/height
// map to different mm sizes per axis on non-square paper (A4 safeW≠safeH),
// so the actual drawn QR is a square inscribed in this box, not the box
// itself. See qrPhysicalBox() in target.js.
const QR_ZONE = { x0: 610, y0: 735, x1: 785, y1: 910 };

// 1 MOA subtends this many millimeters per meter of distance.
const MOA_MM_PER_METER = 0.29089;

// Physical shape size. This is a reaction-time drill, not a precision one —
// what matters is registering "shoot this / don't shoot that" fast, under
// adrenaline, not landing a tight group. 5-8cm diameter is the requested
// range. GRID stays a fixed 1000x1000 logical square no matter which paper
// size is chosen, so the same grid-unit radius maps to a different physical
// size on A4 vs A3 vs Oficio — shapeRadiusRangeGrid() below converts the mm
// target into the right grid-unit range for whichever page is selected.
const SHAPE_DIAM_MM_MIN = 50;
const SHAPE_DIAM_MM_MAX = 80;
function shapeRadiusRangeGrid(pageSize) {
  const spec = PAGE_SPECS[pageSize] || PAGE_SPECS.A4;
  const mmPerUnit = ((spec.safeW / GRID) + (spec.safeH / GRID)) / 2;
  return {
    rMin: (SHAPE_DIAM_MM_MIN / 2) / mmPerUnit,
    rMax: (SHAPE_DIAM_MM_MAX / 2) / mmPerUnit,
  };
}

// ---- Puntería (silueta con zonas A/C/D, estilo competencia) ---------------
// Geometría FIJA (no se sortea por blanco, a diferencia de las figuras de
// reacción). El CONTORNO y las zonas son un diseño propio (no una
// reproducción del blanco oficial de IPSC/USPSA, que tiene derechos de esas
// organizaciones), pero las PROPORCIONES sí están tomadas de medidas
// publicadas públicamente (una medida en pulgadas no es algo que se pueda
// "licenciar" — el dibujo exacto sí). El cuadro de zona A de la cabeza y el
// tamaño de la zona C son una aproximación visual (no encontré una medida
// oficial publicada de la zona C), pensada para verse parecida a un blanco
// real, no para ser una medida certificada. Todo en unidades de grilla
// (0-1000), el mismo espacio normalizado que usan las figuras de reacción —
// así el mismo motor de homografía/detección de disparos sirve sin cambios
// para esta familia de blanco también.
//
// Ancho del torso (build 2026-08-28.26) — pedido directo: "los blancos son
// muy distintos a los que encontras en un polígono, muy finos, no reales en
// relación a las dimensiones de un cuerpo real". Le pregunté qué blanco
// tenía en mente: nombró el B-27 policial (blanco de calificación
// policial/militar de EEUU, clásico en polígonos) y una silueta genérica de
// defensa personal — ambos en PAPEL, sin los anillos concéntricos de
// puntuación (esos los vio en blancos de METAL, no de papel). El ancho real
// de un B-27/B-21 es la hoja completa de 35×45 pulg. (relación ancho:alto
// ≈0.78 — fuente: blog.krtraining.com/target-evolution-b-21-b-21x-to-b-27-
// and-beyond/, gogunzee.com/blogs/range-manual/b-27-target-guide), bastante
// más ancho que el blanco de competencia IPSC/USPSA (18.12×29.93 pulg.,
// ≈0.605) que se usaba hasta esta build — las siluetas genéricas "de
// combate" sin anillos rondan 0.55-0.66 (ej. EIC E-Silhouette 20×36,
// "Bad Guy" 23×35). El torso de abajo se ensanchó de ≈0.601 (356/592) a
// ≈0.69 (410/592) — un término medio entre las dos referencias que dio,
// más cerca del B-27 que nombró primero — manteniendo la misma altura y el
// mismo afinado de cintura relativo (no se volvió "hexagonal", solo más
// ancho en toda su extensión). Las zonas A/C de abajo se agrandaron en la
// misma proporción para seguir viéndose como una zona central del pecho, no
// todo el ancho del torso.
//
// La cabeza es un RECTÁNGULO redondeado (bloque cabeza+cuello), no un
// círculo — se cambió en el build .24 a pedido directo: en los blancos
// IPSC/USPSA reales la cabeza es un bloque rectangular achatado, nunca una
// cabeza redonda (ver README).
const IPSC_HEAD = { cx: 500, cy: 123, w: 150, h: 110, r: 14 };
// Cuadro de zona A de la cabeza — aproximado (ver nota arriba).
const IPSC_HEAD_ZONE_A = { cx: 500, cy: 123, w: 50, h: 64, r: 12 };
// Silueta del torso: hombros redondeados, un quiebre de cuello en el centro
// (para que la cabeza se vea "insertada", no flotando pegada al torso),
// cintura que se angosta y cadera que vuelve a ensanchar un poco — más
// parecido a una silueta humana real que el hexágono de versiones
// anteriores. Ancho de hombros ensanchado en la build .26 (ver nota arriba).
const IPSC_TORSO_POLY = [
  { x: 295, y: 208 }, { x: 373, y: 195 }, { x: 454, y: 210 },
  { x: 500, y: 178 }, // quiebre de cuello
  { x: 546, y: 210 }, { x: 627, y: 195 }, { x: 705, y: 208 },
  { x: 684, y: 300 }, { x: 654, y: 455 }, { x: 674, y: 560 },
  { x: 650, y: 660 }, { x: 350, y: 660 }, { x: 326, y: 560 },
  { x: 346, y: 455 }, { x: 316, y: 300 },
];
// Cuadro de zona A del torso — agrandado en la misma proporción que el
// ensanche del torso (build .26, ver nota arriba) para seguir viéndose como
// una zona central del pecho, no todo el ancho del cuerpo.
const IPSC_ZONE_A = { cx: 500, cy: 358, w: 136, h: 217, r: 16 };
// Zona C — aproximación visual (ver nota arriba), un cuadro más grande
// alrededor de la zona A que llega casi hasta los hombros y baja hasta
// pasada la cintura. Agrandada en la misma proporción que el torso (.26).
const IPSC_ZONE_C = { cx: 500, cy: 358, w: 231, h: 336, r: 22 };
