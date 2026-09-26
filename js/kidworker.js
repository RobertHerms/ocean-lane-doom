// Builds one child's geometry off the main thread.
import { buildKidGeometry } from './kidgeom.js';
self.onmessage = e => {
  const { name, q } = typeof e.data === 'string' ? { name: e.data, q: 1 } : e.data;
  const g = buildKidGeometry(name, q);
  const b = g.body, h = g.hair;
  self.postMessage(g, [b.pos.buffer, b.nrm.buffer, b.index.buffer, b.lab.buffer, b.si.buffer, b.sw.buffer, h.pos.buffer, h.nrm.buffer, h.index.buffer]);
};
