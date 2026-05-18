// @planner:story_id US-LARGE-001
// @planner:proves billing_export_contract
export function exportInvoice(invoice) {
  return {
    id: invoice.id,
    total: Number(invoice.total || 0),
    exported: true
  };
}
