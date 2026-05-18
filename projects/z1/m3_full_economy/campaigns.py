class CampaignEngine:
    """
    Manages the lifecycle of Brand Campaigns, Escrow funding, and fee routing.
    Replaces the static 'brand_inflow_per_epoch' with a dynamic escrow release model.
    """
    def __init__(self, treasury_fee_percentage: float = 0.05, burn_share: float = 0.0):
        self.escrow_balance_z1u = 0.0
        self.treasury_fee_percentage = treasury_fee_percentage
        self.burn_share = burn_share
        self.active_campaigns = 0
        self.cumulative_net_deposits = 0.0

    def deposit_campaign_funds(self, z1u_amount: float) -> tuple[float, float]:
        """
        Brand deposits Z1U into the Campaign Escrow.
        An upfront G9b fee is taken. A portion is routed directly to the Treasury, and a portion is burned (G9c).
        Returns (fee_to_treasury, fee_to_burn).
        """
        if z1u_amount <= 0:
            return 0.0, 0.0

        total_fee = z1u_amount * self.treasury_fee_percentage
        fee_to_burn = total_fee * self.burn_share
        fee_to_treasury = total_fee - fee_to_burn
        net_deposit = z1u_amount - total_fee

        self.escrow_balance_z1u += net_deposit
        self.cumulative_net_deposits += net_deposit
        self.active_campaigns += 1
        return fee_to_treasury, fee_to_burn

    def release_funds_for_utility(self, requested_z1u: float) -> float:
        """
        Releases funds from escrow to cover utility spend.
        If escrow is insufficient, it releases whatever is available.
        """
        if requested_z1u <= 0:
            return 0.0

        released = min(requested_z1u, self.escrow_balance_z1u)
        self.escrow_balance_z1u -= released
        return released
