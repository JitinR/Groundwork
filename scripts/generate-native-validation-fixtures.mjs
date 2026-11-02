import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { defaultDesign } from '../client/src/types.ts';
import { createCadObject } from '../client/src/lib/cadModel.ts';
import { buildDxf } from '../client/src/lib/dxf.ts';

const design = defaultDesign();
design.furniture = [];
if (design.curtains) design.curtains.enabled = false;
design.drafts = [{ ...createCadObject('line'), id: 'native-reference-line', label: 'Synthetic 10 metre reference', x: 6.234, z: 2.345, w: 10, rotationDeg: 0 }];
const dxf = buildDxf(design);
const directory = new URL('../artifacts/native-acceptance/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('source.dxf', directory), dxf);
await writeFile(new URL('source.json', directory), JSON.stringify({
  source: 'Groundwork buildDxf; synthetic room and authored line', sha256: createHash('sha256').update(dxf).digest('hex'),
  units: 'millimetres', insunits: 4, referenceLine: { from: [1234, 2345, 0], to: [11234, 2345, 0], physicalLengthM: 10 },
}, null, 2) + '\n');
console.log('Generated application DXF with an independently dimensioned 10 m reference line.');
