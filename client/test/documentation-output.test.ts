import assert from "node:assert/strict";
import test from "node:test";
import { defaultDesign, type DocumentationView } from "../src/types";
import { defaultDocumentation } from "../src/lib/documentation";
import { buildSheetPdf } from "../src/lib/sheets";
import { createCadObject } from "../src/lib/cadModel";

// Inspect the final PDF's page objects and referenced streams rather than renderer internals.
function pdfPages(bytes: Uint8Array): string[] {
  const source = new TextDecoder().decode(bytes);
  assert.ok(source.startsWith("%PDF-1.4"));
  assert.ok(source.trimEnd().endsWith("%%EOF"));
  const objects = new Map([...source.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj/g)].map(match => [Number(match[1]), match[2]]));
  const pages = [...objects.values()].filter(body => body.includes("/Type /Page "));
  assert.ok(pages.length > 0);
  return pages.map(page => {
    const contents = page.match(/\/Contents (\d+) 0 R/);
    assert.ok(contents, "each page references a content stream");
    const body = objects.get(Number(contents[1]));
    assert.ok(body?.includes("\nstream\n"), "each page's content exists");
    return body!.split("\nstream\n")[1].split("\nendstream")[0];
  });
}

test("every exported page remains visibly schematic and not for construction even when status is issued", () => {
  const design = defaultDesign();
  design.documentation = { ...defaultDocumentation(), status: "issued" };
  const pages = pdfPages(buildSheetPdf("Issued concept", design));
  assert.ok(pages.length >= 6, "exercise the cover, geometry, takeoff, schedule and declaration pages");
  for (const page of pages) {
    assert.ok(page.includes("(SCHEMATIC / NOT TO SCALE / NOT FOR CONSTRUCTION)"), "a separated sheet must retain its output limits");
    let textGray = 0;
    for (const command of page.split("\n")) {
      const shades = [...command.matchAll(/(-?\d+(?:\.\d+)?) g\b/g)];
      if (shades.length) textGray = Number(shades.at(-1)![1]);
      if (command.includes(" Tj ET")) assert.ok(textGray <= 0.25, "PDF text must remain dark and readable after shaded boxes");
    }
  }
});

test("renumbered stock sheets retain their cover, takeoff, and schedule content", () => {
  const design = defaultDesign();
  design.furniture.push({ id: "desk-1", type: "desk", name: "Authored review desk", x: 0, z: 0, rotationDeg: 0, scale: 1, color: "#687b74" });
  const docs = defaultDocumentation();
  const numbers = new Map([["sheet-cover", "COVER-A"], ["sheet-boq", "Q-501A"], ["sheet-schedule", "SCHED-A"]]);
  docs.sheets = docs.sheets.filter(sheet => numbers.has(sheet.id)).map(sheet => ({ ...sheet, number: numbers.get(sheet.id)! }));
  design.documentation = docs;
  const pages = pdfPages(buildSheetPdf("Renumbered", design));
  assert.ok(pages.some(page => page.includes("COVER-A") && page.includes("SHEET INDEX")));
  assert.ok(pages.some(page => page.includes("Q-501A") && page.includes("Room 6 x 4 m") && page.includes("Authored review desk")));
  assert.ok(pages.some(page => page.includes("SCHED-A") && page.includes("STANDARDS SCREENING")));
  assert.ok(pages.some(page => page.includes("SCHED-A") && page.includes("COORDINATION SCHEDULE - LIVE MODEL SCHEDULE")));
});

test("authored CAD is drawn on supported views while undefined sections remain explicit", () => {
  const design = defaultDesign();
  design.drafts = [createCadObject("wall")];
  const before = structuredClone(design);
  const pages = pdfPages(buildSheetPdf("CAD concept", design));
  assert.ok(pages.some(page => page.includes("TOP WIREFRAME PROJECTION | NORTH | SCALE 1:100")));
  assert.ok(pages.some(page => page.includes("ELEVATION WIREFRAME PROJECTION | NORTH | SCALE 1:100")));
  assert.ok(pages.some(page => page.includes("CAD SECTION NOT GENERATED: no section cut plane")));
  assert.ok(pages.every(page => page.includes("NOT FOR CONSTRUCTION")));
  assert.ok(pages.every(page => !page.includes("INTERIOR ROOM SECTION")), "CAD section pages cannot substitute an unrelated legacy room envelope");
  assert.deepEqual(design, before, "coverage disclosure does not change the authored model");
});

test("recorded scale and orientation remain identifiable metadata without changing the saved design", () => {
  const design = defaultDesign();
  const docs = defaultDocumentation();
  docs.views[0] = { ...docs.views[0], scale: "1:37", orientation: "west" };
  docs.sheets = [docs.sheets[1]];
  design.documentation = docs;
  const before = structuredClone(design);
  const pages = pdfPages(buildSheetPdf("Review (A)", design));
  assert.ok(pages.some(page => page.includes("(RECORDED METADATA ONLY: scale 1:37 / orientation west)")));
  assert.ok(pages.every(page => page.includes("NOT TO SCALE")));
  assert.ok(pages.every(page => !page.includes("WEST (schematic)")), "the title block must not suggest that the requested elevation was rendered");
  assert.deepEqual(design, before, "export preserves all legacy view metadata and model data");
});

test("continuation pages retain output limits when the set has no cover or generated geometry", () => {
  const design = defaultDesign();
  const docs = defaultDocumentation();
  docs.sheets = [{ id: "notes-only", number: "S-401", name: "Review notes", viewIds: [] }];
  docs.annotations = Array.from({ length: 45 }, (_, index) => ({
    id: "note-" + index,
    text: "Independent review note " + index + " " + "Review the stored assumptions and dimensions. ".repeat(4),
  }));
  design.documentation = docs;
  const pages = pdfPages(buildSheetPdf("Notes-only review", design));
  assert.ok(pages.length > 5, "exercise multiple annotation continuations");
  assert.ok(pages.every(page => page.includes("SCHEMATIC / NOT TO SCALE / NOT FOR CONSTRUCTION")));
});

test("hidden and unbound views still produce classified review pages without rewriting their bindings", () => {
  const design = defaultDesign();
  const docs = defaultDocumentation();
  docs.views[0].visible = false;
  docs.sheets = [
    { id: "hidden", number: "A-101", name: "Hidden view", viewIds: [docs.views[0].id] },
    { id: "unbound", number: "A-102", name: "Unbound view", viewIds: [] },
  ];
  design.documentation = docs;
  const before = structuredClone(design);
  const pages = pdfPages(buildSheetPdf("Incomplete review", design));
  assert.ok(pages.some(page => page.includes("VIEW HIDDEN: Overall plan")));
  assert.ok(pages.some(page => page.includes("No model view is bound")));
  assert.ok(pages.every(page => page.includes("NOT FOR CONSTRUCTION")));
  assert.deepEqual(design, before);
});

function cadDrawing(options: Partial<DocumentationView> = {}) {
  const design = defaultDesign(), docs = defaultDocumentation();
  design.drafts = [{ ...createCadObject("wall"), id: "measured-wall", w: 10, d: 2, h: 3 }];
  docs.views = [{ ...docs.views[0], ...options }];
  docs.sheets = [{ id: "drawing", number: "A-101", name: "Measured CAD drawing", viewIds: [docs.views[0].id] }];
  docs.schedules = [];
  design.documentation = docs;
  return design;
}

function drawnPoints(page: string, objectId: string): { x: number; y: number }[] {
  const lines = page.split("\n"), points: { x: number; y: number }[] = [];
  for (let index = 0; index < lines.length - 1; index++) {
    if (lines[index] !== `% CAD object ${objectId}`) continue;
    for (const match of lines[index + 1].matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) [ml]/g)) points.push({ x: Number(match[1]), y: Number(match[2]) });
  }
  assert.ok(points.length >= 2, "the exported PDF contains actual authored geometry");
  return points;
}
const span = (points: { x: number; y: number }[], axis: "x" | "y") => Math.max(...points.map(point => point[axis])) - Math.min(...points.map(point => point[axis]));
const paperMillimetres = (points: number) => points / 72 * 25.4;
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 0.01, `${actual} mm should equal ${expected} mm on paper`);

test("a known ten-metre CAD edge prints at 100 millimetres at 1:100 without page fitting", () => {
  const design = cadDrawing(), before = structuredClone(design);
  const pages = pdfPages(buildSheetPdf("Measured plan", design)), drawing = pages[0];
  const points = drawnPoints(drawing, "measured-wall");
  close(paperMillimetres(span(points, "x")), 100);
  close(paperMillimetres(span(points, "y")), 20);
  assert.ok(drawing.includes("MODEL PROJECTION / SCALE 1:100 \\(PRINT AT 100%\\) / NOT FOR CONSTRUCTION"));
  assert.ok(drawing.includes("SCALE BAR"));
  assert.ok(pages.slice(1).every(page => page.includes("SCHEMATIC / NOT TO SCALE / NOT FOR CONSTRUCTION")), "notes and declarations cannot inherit a geometric scale");
  assert.deepEqual(design, before);
});

test("cardinal orientation and elevation change the actual projected PDF geometry", () => {
  const east = pdfPages(buildSheetPdf("East plan", cadDrawing({ orientation: "east" })))[0];
  const eastPoints = drawnPoints(east, "measured-wall");
  close(paperMillimetres(span(eastPoints, "x")), 20);
  close(paperMillimetres(span(eastPoints, "y")), 100);
  const elevation = pdfPages(buildSheetPdf("East elevation", cadDrawing({ kind: "elevation", orientation: "east" })))[0];
  const elevationPoints = drawnPoints(elevation, "measured-wall");
  close(paperMillimetres(span(elevationPoints, "x")), 20);
  close(paperMillimetres(span(elevationPoints, "y")), 30);
  assert.ok(elevation.includes("ELEVATION WIREFRAME PROJECTION | EAST"));
});

test("oversized or invalid scales reject the export without silently shrinking, clipping or mutating the model", () => {
  const design = cadDrawing({ scale: "1:10" }), before = structuredClone(design);
  assert.throws(() => buildSheetPdf("Oversized", design), /does not fit.*not shrunk or clipped/);
  assert.deepEqual(design, before);
  assert.throws(() => buildSheetPdf("Invalid scale", cadDrawing({ scale: "1:0" })), /enter a scale/);
  assert.throws(() => buildSheetPdf("Invalid scale", cadDrawing({ scale: "fit 1:100" })), /enter a scale/);
  assert.throws(() => buildSheetPdf("Undefined direction", cadDrawing({ orientation: "custom" })), /orientation|cardinal|custom/i);
});

test("NTS fits authored geometry but does not claim physical scale or include a misleading scale bar", () => {
  const drawing = pdfPages(buildSheetPdf("Unscaled", cadDrawing({ scale: "NTS" })))[0];
  assert.ok(drawing.includes("MODEL PROJECTION / NOT TO SCALE / NOT FOR CONSTRUCTION"));
  assert.ok(!drawing.includes("SCALE BAR"));
  assert.ok(!drawing.includes("PRINT AT 100%"));
  const points = drawnPoints(drawing, "measured-wall");
  assert.ok(span(points, "x") <= 660 && span(points, "y") <= 300);
});

test("an explicitly defined vertical section prints the actual cut at physical scale and keeps its declared plane", () => {
  const design = cadDrawing({ kind: "section", orientation: "north", section: { axis: "z", offsetM: 0 } });
  const before = structuredClone(design), drawing = pdfPages(buildSheetPdf("Measured cut", design))[0];
  const points = drawnPoints(drawing, "measured-wall");
  close(paperMillimetres(span(points, "x")), 100);
  close(paperMillimetres(span(points, "y")), 30);
  assert.ok(drawing.includes("CAD SECTION / SCALE 1:100 \\(PRINT AT 100%\\) / NOT FOR CONSTRUCTION"));
  assert.ok(drawing.includes("SECTION Z=0 m | LOOK NORTH"));
  assert.ok(drawing.includes("Section boundary edges only"));
  assert.deepEqual(design, before);
  const away = pdfPages(buildSheetPdf("Missed cut", cadDrawing({ kind: "section", orientation: "north", section: { axis: "z", offsetM: 2 } })))[0];
  assert.ok(away.includes("NO GEOMETRY / NOT TO SCALE"));
  assert.ok(away.includes("1 not cut"));
  assert.ok(!away.includes("% CAD object measured-wall"));
});

test("section directions must match the authored plane and never inherit an unrelated elevation", () => {
  assert.throws(() => buildSheetPdf("Mismatched section", cadDrawing({ kind: "section", orientation: "east", section: { axis: "z", offsetM: 0 } })), /orientation|direction|normal|plane/i);
  assert.throws(() => buildSheetPdf("Invalid section", cadDrawing({ kind: "section", orientation: "north", section: { axis: "z", offsetM: Infinity } })), /finite|coordinate|offset/i);
  const withoutPlane = pdfPages(buildSheetPdf("Undefined section", cadDrawing({ kind: "section", orientation: "north" })))[0];
  assert.ok(withoutPlane.includes("CAD SECTION NOT GENERATED"));
  assert.ok(!withoutPlane.includes("% CAD object measured-wall"));
});
