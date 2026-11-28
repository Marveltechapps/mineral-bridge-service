/**
 * Bulk removal of catalogue minerals (customer products) from the Lots screen.
 * Minerals with no business history are deleted. Minerals referenced by orders,
 * auctions, inspections, contracts, payments, negotiations, or vault lots are
 * archived (withdrawn) so those records stay readable and the mineral cannot
 * be bought or quoted again.
 */
import { unprocessable } from '../../../common/errors/app-error.js';
import { recordAudit } from '../../audit/audit.service.js';
import { AuctionModel } from '../../../models/auction.model.js';
import { CartModel, QuoteModel } from '../../../models/cart.model.js';
import { ProductModel } from '../../../models/catalog.model.js';
import { ContractModel } from '../../../models/contract-lc.model.js';
import { OrderModel } from '../../../models/order.model.js';
import { VaultLot } from '../../../models/trading.models.js';
import { NegotiationModel } from '../../../models/web-trade.model.js';
import { InspectionModel, PaymentModel } from '../../../models/workflow.model.js';

const MAX_IDS = 2000;

export interface BulkLotDeleteResult {
  /** Unique ids the admin asked to remove. */
  selected: number;
  /** References removed from the catalogue collection. */
  deleted: string[];
  /** References kept and marked withdrawn because history still points at them. */
  archived: string[];
  /** Ids that were not in the catalogue. */
  missing: string[];
}

type ProductHit = { _id: string; reference: string };

function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = String(raw || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export async function bulkDeleteConsoleLots(
  ids: string[],
  staff?: { id: string; name: string },
): Promise<BulkLotDeleteResult> {
  const unique = uniqueIds(ids);
  if (!unique.length) throw unprocessable('Select at least one mineral.', { ids: 'Required' });
  if (unique.length > MAX_IDS) throw unprocessable(`Select at most ${MAX_IDS} minerals at once.`, { ids: 'Too many' });

  const products = await ProductModel.find({
    $or: [{ reference: { $in: unique } }, { _id: { $in: unique } }],
  }).select('_id reference').lean<ProductHit[]>();

  const found = new Map<string, ProductHit>();
  const idByToken = new Map<string, string>();
  for (const product of products) {
    const id = String(product._id);
    found.set(id, { _id: id, reference: product.reference });
    idByToken.set(id, id);
    if (product.reference) idByToken.set(product.reference, id);
  }

  const missing = unique.filter((id) => !idByToken.has(id));
  const tokens = [...idByToken.keys()];
  if (!tokens.length) {
    return { selected: unique.length, deleted: [], archived: [], missing };
  }

  const referenced = new Set<string>();
  const note = (value?: string | null) => {
    if (!value) return;
    const id = idByToken.get(String(value));
    if (id) referenced.add(id);
  };

  const [orders, auctions, negotiations, vaultLots] = await Promise.all([
    OrderModel.find({
      $or: [{ 'lines.productId': { $in: tokens } }, { 'source.refId': { $in: tokens } }],
    }).select('_id side lines.productId source.refId').lean(),
    AuctionModel.find({ productId: { $in: tokens } }).select('_id productId').lean(),
    NegotiationModel.find({ lotId: { $in: tokens } }).select('_id lotId orderId').lean(),
    VaultLot.find({ productId: { $in: tokens } }).select('_id productId').lean(),
  ]);

  const orderIds = new Set<string>();
  for (const order of orders) {
    orderIds.add(String(order._id));
    note(order.source?.refId);
    for (const line of order.lines ?? []) note(line.productId);
  }
  for (const auction of auctions) note(auction.productId);
  for (const negotiation of negotiations) {
    note(negotiation.lotId);
    if (negotiation.orderId) orderIds.add(String(negotiation.orderId));
  }
  for (const lot of vaultLots) note(lot.productId);

  // Inspections, contracts, and payments hang off orders. Load them so a mineral
  // is archived when any of those records exist, and so this path never deletes them.
  const orderIdList = [...orderIds];
  if (orderIdList.length) {
    const [inspections, contracts, payments] = await Promise.all([
      InspectionModel.find({ orderId: { $in: orderIdList } }).select('orderId').lean(),
      ContractModel.find({ $or: [{ orderId: { $in: orderIdList } }, { negotiationId: { $in: negotiations.map((n) => String(n._id)) } }] }).select('orderId').lean(),
      PaymentModel.find({ orderId: { $in: orderIdList } }).select('orderId').lean(),
    ]);
    const protectedOrders = new Set<string>();
    for (const row of inspections) protectedOrders.add(String(row.orderId));
    for (const row of contracts) if (row.orderId) protectedOrders.add(String(row.orderId));
    for (const row of payments) protectedOrders.add(String(row.orderId));
    if (protectedOrders.size) {
      for (const order of orders) {
        if (!protectedOrders.has(String(order._id))) continue;
        note(order.source?.refId);
        for (const line of order.lines ?? []) note(line.productId);
      }
    }
  }

  const archiveIds = [...found.keys()].filter((id) => referenced.has(id));
  const deleteIds = [...found.keys()].filter((id) => !referenced.has(id));

  if (archiveIds.length) {
    await ProductModel.updateMany({ _id: { $in: archiveIds } }, { $set: { status: 'withdrawn' } });
  }
  if (deleteIds.length) {
    await ProductModel.deleteMany({ _id: { $in: deleteIds } });
  }

  // Drop live carts and price quotes so a removed or archived mineral cannot be purchased.
  // Orders, payments, auctions, inspections, contracts, and negotiations are left intact.
  await CartModel.updateMany(
    { 'items.productId': { $in: tokens } },
    { $pull: { items: { productId: { $in: tokens } } } },
  );
  await QuoteModel.deleteMany({ lotId: { $in: tokens } });

  const deleted = deleteIds.map((id) => found.get(id)!.reference);
  const archived = archiveIds.map((id) => found.get(id)!.reference);

  try {
    await recordAudit({
      actor: staff ? { staffId: staff.id, name: staff.name } : undefined,
      category: 'content',
      action: 'Catalogue minerals removed',
      record: { type: 'lot', id: 'catalogue-bulk', label: `${deleted.length} deleted, ${archived.length} archived` },
      reason: 'Bulk delete from Catalogue lots',
      after: { deleted: deleted.length, archived: archived.length, missing: missing.length },
    });
  } catch {
    // The catalogue write already succeeded. An audit failure must not put minerals back.
  }

  return { selected: unique.length, deleted, archived, missing };
}
