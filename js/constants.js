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
// reacción) — pensada para parecerse a la proporción general de un blanco
// métrico de competencia (torso + cabeza + zonas A/C/D), pero es un diseño
// propio, NO una reproducción del blanco oficial de IPSC ni de ningún otro
// organismo: IPSC licencia su blanco métrico, así que copiarlo tal cual y
// distribuirlo sería un problema de derechos, no técnico. Todo en unidades
// de grilla (0-1000), el mismo espacio normalizado que usan las figuras de
// reacción — así el mismo motor de homografía/detección de disparos sirve
// sin cambios para esta familia de blanco también.
const IPSC_HEAD = { cx: 500, cy: 150, r: 68 };
const IPSC_TORSO_POLY = [
  { x: 330, y: 232 }, { x: 670, y: 232 }, // hombros
  { x: 652, y: 470 }, { x: 618, y: 660 }, // costado derecho hasta la cadera
  { x: 382, y: 660 }, { x: 348, y: 470 }, // costado izquierdo de vuelta
];
const IPSC_ZONE_A = { cx: 500, cy: 335, rx: 100, ry: 155 };
const IPSC_ZONE_C = { cx: 500, cy: 390, rx: 185, ry: 250 };
