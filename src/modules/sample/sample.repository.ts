import type { SampleItem } from './sample.model.js';

const items: SampleItem[] = [
  { id: 'sample-001', name: 'Sample mineral', description: 'Example data for the Mineral Bridge project structure.' },
];

export function findSamples(limit: number): SampleItem[] {
  return items.slice(0, limit).map(item => ({ ...item }));
}
