import { findSamples } from './sample.repository.js';

export function listSamples(limit: number) {
  return findSamples(limit);
}
