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
