/** Parent links for Category → Subcategory → Mineral Type → Product Form. */
export interface HierarchyLink {
  categorySlug: string;
  subcategorySlug: string;
  subcategoryCategorySlug: string;
  mineralTypeSlug: string;
  mineralTypeCategorySlug: string;
  mineralTypeSubcategorySlug?: string;
  productFormCategorySlug?: string;
  productFormSubcategorySlug?: string;
  productFormMineralTypeSlug?: string;
}

/**
 * Returns the reasons a child cannot hang off the given parents.
 * An empty list means the chain is consistent.
 */
export function hierarchyErrors(link: HierarchyLink): string[] {
  const errors: string[] = [];
  if (link.subcategoryCategorySlug !== link.categorySlug) errors.push('subcategory does not belong to category');
  if (link.mineralTypeCategorySlug !== link.categorySlug) errors.push('mineral type does not belong to category');
  if (link.mineralTypeSubcategorySlug && link.mineralTypeSubcategorySlug !== link.subcategorySlug) {
    errors.push('mineral type does not belong to subcategory');
  }
  if (link.productFormMineralTypeSlug) {
    if (link.productFormCategorySlug !== link.categorySlug) errors.push('product form does not belong to category');
    if (link.productFormSubcategorySlug && link.productFormSubcategorySlug !== link.subcategorySlug) {
      errors.push('product form does not belong to subcategory');
    }
    if (link.productFormMineralTypeSlug !== link.mineralTypeSlug) errors.push('product form does not belong to mineral type');
  }
  return errors;
}

/** Last path segment of an image URL, percent-decoded. Plus signs are left as written. */
export function imageNameFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}

/**
 * The sheet relationship is the mineral id embedded in the image path.
 * A name overlap is not treated as proof that the image belongs to the record.
 */
export function imageMatchesSource(url: string, sourceId: string): boolean {
  if (!sourceId) return false;
  let hay = url;
  try {
    hay = decodeURIComponent(url);
  } catch {
    hay = url;
  }
  return hay.toLowerCase().includes(sourceId.toLowerCase());
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif)$/i;

/**
 * Sheet image paths sometimes omit the file extension. CloudFront only serves
 * those objects when `.png` is present, and returns 403 otherwise.
 */
export function repairCatalogImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const hashAt = url.indexOf('#');
  const withoutHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const fragment = hashAt === -1 ? '' : url.slice(hashAt);
  const queryAt = withoutHash.indexOf('?');
  const path = queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt);
  const query = queryAt === -1 ? '' : withoutHash.slice(queryAt);
  if (IMAGE_EXT.test(path)) return url;
  return `${path}.png${query}${fragment}`;
}

/** An image the mobile app can load on any device. Relative and bundled asset paths are not. */
export function httpCatalogImage(url: string | null | undefined): string | null {
  const repaired = repairCatalogImageUrl(url);
  if (!repaired || !/^https?:\/\//i.test(repaired)) return null;
  return repaired;
}

export interface CatalogImageRef {
  url: string;
  name: string | null;
}

/**
 * Image for one mineral. Uses that record's own URL, then a form that belongs to it.
 * A form from another mineral is never considered.
 */
export function pickCatalogImage(
  label: string,
  ownUrl: string | null | undefined,
  ownName: string | null | undefined,
  forms: { name: string; imageUrl?: string | null; imageName?: string | null; isActive?: boolean }[],
): CatalogImageRef | null {
  const own = httpCatalogImage(ownUrl);
  if (own) return { url: own, name: ownName ?? null };
  const wanted = label.trim().toLowerCase();
  const ready = forms
    .filter((form) => form.isActive !== false)
    .map((form) => ({ name: form.name, imageName: form.imageName ?? null, url: httpCatalogImage(form.imageUrl) }))
    .filter((form): form is { name: string; imageName: string | null; url: string } => !!form.url)
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  if (!ready.length) return null;
  const exact = ready.find((form) => form.name.trim().toLowerCase() === wanted);
  const prefixed = ready.find((form) => form.name.trim().toLowerCase().startsWith(wanted));
  const pick = exact ?? prefixed ?? ready[0]!;
  return { url: pick.url, name: pick.imageName };
}
