// guidance_reminder.mjs — Shared advisory NEXT/WHY presentation contract.
// @planner:module = guidance_reminder
// @planner:capability = advisory_next_why_reminders_at_deterministic_choke_points
// @planner:story = US-073

function meaningful(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function buildGuidanceReminder({
  triggered = false,
  surface = null,
  reason = null,
  nextCommand = null,
  why = null,
} = {}) {
  if (!triggered || !meaningful(nextCommand) || !meaningful(why)) return null;
  return {
    surface: meaningful(surface) ? surface.trim() : "deterministic_choke_point",
    reason: meaningful(reason) ? reason.trim() : "operator_action_available",
    next_command: nextCommand.trim(),
    why: why.trim(),
    authority: {
      advisory_only: true,
      adds_gate_obligation: false,
    },
  };
}

export function renderGuidanceReminder(reminder, { indent = "" } = {}) {
  if (!reminder || !meaningful(reminder.next_command) || !meaningful(reminder.why)) return "";
  const prefix = typeof indent === "string" ? indent : "";
  return [
    `${prefix}💡 Guidance available`,
    `${prefix}   NEXT: ${reminder.next_command}`,
    `${prefix}   WHY:  ${reminder.why}`,
    `${prefix}   Advisory only: this reminder does not add a gate obligation or change the result.`,
  ].join("\n");
}
