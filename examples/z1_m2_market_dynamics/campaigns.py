class CampaignEngine:
    """
    Manages the lifecycle of Brand Campaigns, Escrow funding, and fee routing.
    Replaces the static 'brand_inflow_per_epoch' with a dynamic escrow release model.
    """
    def __init__(self, treasury_fee_percentage: float = 0.05):
        self.escrow_balance_z1u = 0.0
        self.treasury_fee_percentage = treasury_fee_percentage
        self.active_campaigns = 0
        self.cumulative_net_deposits = 0.0

    def deposit_campaign_funds(self, z1u_amount: float) -> float:
        """
        Brand deposits Z1U into the Campaign Escrow.
        An upfront G9b fee is taken and routed directly to the Treasury.
        Returns the fee amount to be routed to the Treasury.
        """
        if z1u_amount <= 0:
            return 0.0

        fee_amount = z1u_amount * self.treasury_fee_percentage
        net_deposit = z1u_amount - fee_amount

        self.escrow_balance_z1u += net_deposit
        self.cumulative_net_deposits += net_deposit
        self.active_campaigns += 1
        return fee_amount

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
