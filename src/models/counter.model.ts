import { defineModel } from './_shared.js';

export interface ICounter {
  _id: string;
  seq: number;
}

export const CounterModel = defineModel<ICounter>('Counter', {
  _id: { type: String },
  seq: { type: Number, default: 0 },
});
