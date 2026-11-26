// A worker that extends node:stream Transform: its separately built bundle must be in the graph.
import { Transform } from 'node:stream';

export class Probe extends Transform {}
self.postMessage(String(new Probe()));
