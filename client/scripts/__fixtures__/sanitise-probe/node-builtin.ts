// unit:sanitise-bundle failing probe (plan #198 Part 2a §3.6): extends Transform from node:stream,
// as SAXParser does, so the browser build must hold Vite's browser-external id for it.
import { Transform } from 'node:stream';

export class Probe extends Transform {}
document.body.addEventListener('click', () => {
  console.log(new Probe());
});
