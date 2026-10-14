import { findSamples } from './sample.repository';

export function listSamples(limit: number) {
  return findSamples(limit);
}
