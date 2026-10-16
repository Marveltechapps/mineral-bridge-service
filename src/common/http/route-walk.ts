import type { Router } from 'express';

export type WalkedRoute = { method: string; path: string };

type Layer = {
  route?: { path: string | string[]; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
  regexp?: RegExp & { fast_slash?: boolean };
};

/** Recover a literal mount path from an Express 4 layer regexp (`^\/x\/?(?=\/|$)` → `/x`). Params are kept as `:param`. */
function mountPath(layer: Layer): string {
  if (!layer.regexp || layer.regexp.fast_slash) return '';
  const src = layer.regexp.source;
  const m = /^\^((?:\\\/|[^\\$?()|*+[\]{}])*?)(?:\\\/\?)?\(\?=\\\/\|\$\)$/.exec(src);
  if (!m) return '';
  return m[1]!.replace(/\\\//g, '/');
}

/**
 * Enumerate every METHOD + path registered on an Express 4 router (recursing into nested routers).
 * Used by the endpoint-coverage audit and by the route-registry tests; never at request time.
 */
export function walkRoutes(router: Router, prefix = ''): WalkedRoute[] {
  const out: WalkedRoute[] = [];
  const stack = (router as unknown as { stack: Layer[] }).stack ?? [];
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        for (const method of Object.keys(layer.route.methods)) {
          if (layer.route.methods[method]) out.push({ method: method.toUpperCase(), path: `${prefix}${p}` });
        }
      }
    } else if (layer.handle?.stack) {
      out.push(...walkRoutes(layer.handle as unknown as Router, `${prefix}${mountPath(layer)}`));
    }
  }
  return out;
}
